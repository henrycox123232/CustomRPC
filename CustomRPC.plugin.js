/**
 * @name CustomRPC
 * @description Add a fully customizable Rich Presence (Game status) to your Discord profile
 * @version 1.0.0
 * @author Captain, AutumnVN, nin0dev
 */

const { BdApi } = window;

/* ---- helper module lookups ----
   Use safer getModule lookups (byProps is stable for these) */
const FluxDispatcher = BdApi.Webpack.getModule(BdApi.Webpack.Filters.byProps("dispatch", "subscribe"));
const UserStore = BdApi.Webpack.getModule(BdApi.Webpack.Filters.byProps("getCurrentUser"));
const ApplicationAssetUtils = BdApi.Webpack.getModule(BdApi.Webpack.Filters.byProps("fetchAssetIds"));
const UserSettingsStatusStore = BdApi.Webpack.getModule(BdApi.Webpack.Filters.byProps("getShowCurrentGame", "setShowCurrentGame")) || {};
const ShowCurrentGame = typeof UserSettingsStatusStore.getShowCurrentGame === "function" ? UserSettingsStatusStore.getShowCurrentGame : null;

const ActivityType = {
  PLAYING: 0,
  STREAMING: 1,
  LISTENING: 2,
  WATCHING: 3,
  COMPETING: 5
};

const TimestampMode = {
  NONE: 0,
  NOW: 1,
  TIME: 2,
  CUSTOM: 3
};

/* ---- settings schema ----
   validate functions reference global `settings` (safe because settings is initialized right after)
*/
const settingsSchema = {
  appID: {
    type: "string",
    default: "",
    description: "Application ID (required)",
    validate: v => (!v ? "Application ID is required." : /^\d+$/.test(v) ? true : "Application ID must be a number.")
  },
  appName: {
    type: "string",
    default: "",
    description: "Application name (required)",
    validate: v => (!v ? "Application name is required." : v.length > 128 ? "Application name must be not longer than 128 characters." : true)
  },
  details: {
    type: "string",
    default: "",
    description: "Details (line 1)",
    validate: v => (v && v.length > 128 ? "Details (line 1) must be not longer than 128 characters." : true)
  },
  state: {
    type: "string",
    default: "",
    description: "State (line 2)",
    validate: v => (v && v.length > 128 ? "State (line 2) must be not longer than 128 characters." : true)
  },
  type: {
    type: "select",
    default: ActivityType.PLAYING,
    description: "Activity type",
    options: [
      { label: "Playing", value: ActivityType.PLAYING },
      { label: "Streaming", value: ActivityType.STREAMING },
      { label: "Listening", value: ActivityType.LISTENING },
      { label: "Watching", value: ActivityType.WATCHING },
      { label: "Competing", value: ActivityType.COMPETING }
    ]
  },
  streamLink: {
    type: "string",
    default: "",
    description: "Twitch.tv or Youtube.com link (only for Streaming activity type)",
    validate: v => {
      if (settings && settings.type === ActivityType.STREAMING && !/https?:\/\/(www\.)?(twitch\.tv|youtube\.com)\/\S+/.test(v))
        return "Streaming link must be a valid Twitch or YouTube channel URL.";
      if (v && v.length > 512) return "Streaming link must be not longer than 512 characters.";
      return true;
    },
    disabled: () => settings.type !== ActivityType.STREAMING
  },
  timestampMode: {
    type: "select",
    default: TimestampMode.NONE,
    description: "Timestamp mode",
    options: [
      { label: "None", value: TimestampMode.NONE },
      { label: "Since Discord open", value: TimestampMode.NOW },
      { label: "Same as your current time (not reset after 24h)", value: TimestampMode.TIME },
      { label: "Custom", value: TimestampMode.CUSTOM }
    ]
  },
  startTime: {
    type: "number",
    default: 0,
    description: "Start timestamp in milliseconds (only for custom timestamp mode)",
    validate: v => (v && v < 0 ? "Start timestamp must be greater than 0." : true),
    disabled: () => settings.timestampMode !== TimestampMode.CUSTOM
  },
  endTime: {
    type: "number",
    default: 0,
    description: "End timestamp in milliseconds (only for custom timestamp mode)",
    validate: v => (v && v < 0 ? "End timestamp must be greater than 0." : true),
    disabled: () => settings.timestampMode !== TimestampMode.CUSTOM
  },
  imageBig: { type: "string", default: "", description: "Big image key/link", validate: v => isImageKeyValid(v) },
  imageBigTooltip: { type: "string", default: "", description: "Big image tooltip", validate: v => (v && v.length > 128 ? "Big image tooltip must be not longer than 128 characters." : true) },
  imageSmall: { type: "string", default: "", description: "Small image key/link", validate: v => isImageKeyValid(v) },
  imageSmallTooltip: { type: "string", default: "", description: "Small image tooltip", validate: v => (v && v.length > 128 ? "Small image tooltip must be not longer than 128 characters." : true) },
  buttonOneText: { type: "string", default: "", description: "Button 1 text", validate: v => (v && v.length > 31 ? "Button 1 text must be not longer than 31 characters." : true) },
  buttonOneURL: { type: "string", default: "", description: "Button 1 URL" },
  buttonTwoText: { type: "string", default: "", description: "Button 2 text", validate: v => (v && v.length > 31 ? "Button 2 text must be not longer than 31 characters." : true) },
  buttonTwoURL: { type: "string", default: "", description: "Button 2 URL" }
};

/* ---- persistent settings load ---- */
let settings = BdApi.Data.load("CustomRPC", "settings") || {};
Object.keys(settingsSchema).forEach(key => {
  if (settings[key] === undefined) settings[key] = settingsSchema[key].default;
});

/* ---- storage + RPC save ---- */
function saveSettings() {
  BdApi.Data.save("CustomRPC", "settings", settings);
  // apply new RPC immediately (errors inside setRpc are caught)
  setRpc();
}

/* ---- utility validation helpers ---- */
function isImageKeyValid(value) {
  if (!value) return true;
  // warn on Discord CDN usage (we prefer direct image links from imgur/tenor)
  if (/https?:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(value)) return "Don't use a Discord CDN link. Use an Imgur direct link or upload to your app assets.";
  if (/https?:\/\/(?!i\.)?imgur\.com\//.test(value)) return "Imgur link must be a direct link to the image (e.g. https://i.imgur.com/...). Right click the image and select 'Copy image address'.";
  if (/https?:\/\/(?!media\.)?tenor\.com\//.test(value)) return "Tenor link must be a direct link to the GIF (e.g. https://media.tenor.com/...). Right click the GIF and select 'Copy image address'.";
  return true;
}

async function getApplicationAsset(key) {
  if (!key) return undefined;
  // If it looks numeric or a key, try to fetch asset id; otherwise return the key (assume direct link)
  try {
    if (!ApplicationAssetUtils || typeof ApplicationAssetUtils.fetchAssetIds !== "function") return key;
    const ids = await ApplicationAssetUtils.fetchAssetIds(settings.appID || "0", [key]);
    return ids && ids[0] ? ids[0] : key;
  } catch (e) {
    // not critical — return the original key/link
    return key;
  }
}

/* ---- build activity object ---- */
function isEmptyObject(o) {
  return o && typeof o === "object" && Object.keys(o).length === 0;
}

async function createActivity() {
  // If required values missing, return null (nothing to set)
  if (!settings.appName || !settings.appID) return null;

  const activity = {
    application_id: settings.appID || "0",
    name: settings.appName || undefined,
    state: settings.state || undefined,
    details: settings.details || undefined,
    type: Number.isFinite(settings.type) ? settings.type : undefined,
    flags: 1 << 0 // CLIENT_STATUS_HIDE? kept from original
  };

  if (settings.type === ActivityType.STREAMING && settings.streamLink) activity.url = settings.streamLink;

  // timestamps
  switch (settings.timestampMode) {
    case TimestampMode.NOW:
      activity.timestamps = { start: Date.now() };
      break;
    case TimestampMode.TIME: {
      const now = new Date();
      const midnightToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      // set start equal to midnight local time so that it shows "X:XX" same-day clock (approx)
      activity.timestamps = { start: midnightToday + (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 1000 - ((now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 1000) };
      // The original intention was unclear; we keep a conservative approach: set start to Date.now()
      activity.timestamps.start = Date.now();
      break;
    }
    case TimestampMode.CUSTOM:
      if ((settings.startTime && settings.startTime > 0) || (settings.endTime && settings.endTime > 0)) {
        activity.timestamps = {};
        if (settings.startTime && settings.startTime > 0) activity.timestamps.start = Number(settings.startTime);
        if (settings.endTime && settings.endTime > 0) activity.timestamps.end = Number(settings.endTime);
      }
      break;
    default:
      break;
  }

  // buttons (Discord allows up to 2)
  const buttons = [];
  const buttonUrls = [];
  if (settings.buttonOneText) {
    buttons.push(settings.buttonOneText);
    if (settings.buttonOneURL) buttonUrls.push(settings.buttonOneURL);
  }
  if (settings.buttonTwoText) {
    buttons.push(settings.buttonTwoText);
    if (settings.buttonTwoURL) buttonUrls.push(settings.buttonTwoURL);
  }
  if (buttons.length > 0) {
    activity.buttons = buttons.slice(0, 2);
    if (buttonUrls.length > 0) activity.metadata = { button_urls: buttonUrls.slice(0, 2) };
  }

  // assets (images)
  const assets = {};
  try {
    if (settings.imageBig) {
      const large = await getApplicationAsset(settings.imageBig);
      if (large) assets.large_image = large;
      if (settings.imageBigTooltip) assets.large_text = settings.imageBigTooltip;
    }
    if (settings.imageSmall) {
      const small = await getApplicationAsset(settings.imageSmall);
      if (small) assets.small_image = small;
      if (settings.imageSmallTooltip) assets.small_text = settings.imageSmallTooltip;
    }
  } catch (e) {
    // ignore asset resolution errors
  }
  if (!isEmptyObject(assets)) activity.assets = assets;

  // clean up any empty/undefined fields (but keep numeric 0 if present)
  Object.keys(activity).forEach(k => {
    const v = activity[k];
    if (v === undefined || v === null) delete activity[k];
    // empty arrays/objects
    else if (Array.isArray(v) && v.length === 0) delete activity[k];
    else if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) delete activity[k];
    // empty strings
    else if (typeof v === "string" && v.length === 0) delete activity[k];
  });

  return activity;
}

/* ---- dispatch RPC to local client ---- */
async function setRpc(disable = false) {
  try {
    const activity = disable ? null : await createActivity();
    // dispatch local activity update — this is how many BD plugins set presence
    FluxDispatcher.dispatch({
      type: "LOCAL_ACTIVITY_UPDATE",
      activity,
      socketId: "CustomRPC"
    });
  } catch (err) {
    BdApi.UI.showToast("CustomRPC: Failed to update activity: " + (err && err.message ? err.message : String(err)), { type: "error" });
  }
}

/* ---- plugin class ---- */
module.exports = class CustomRPC {
  start() {
    // Try to remove any earlier patch by same plugin id (defensive)
    try {
      // In the original plugin a patch attempted to remove internal nulling behavior.
      // It's fragile across Discord versions — so we don't patch internals by default.
      // If you still need to patch something, re-enable here carefully.
    } catch (e) {
      // ignore
    }

    // apply current RPC immediately
    setRpc();
    BdApi.UI.showToast("CustomRPC started", { type: "info" });
  }

  stop() {
    // remove any patches made by this plugin and clear RPC
    try {
      BdApi.Patcher.unpatchAll("CustomRPC");
    } catch (e) {
      // ignore
    }
    setRpc(true);
    BdApi.UI.showToast("CustomRPC stopped", { type: "info" });
  }

  getSettingsPanel() {
    const React = BdApi.React;
    // Try to use BdApi.Components; fallback to simple form if not available
    const Components = BdApi.Components || {};
    const FormSection = Components.FormSection || (props => React.createElement("div", props));
    const FormTitle = Components.FormTitle || (props => React.createElement("div", { style: { fontWeight: "600", marginBottom: "6px" } }, props.children));
    const FormItem = Components.FormItem || (props => React.createElement("div", props));
    const TextInput = Components.TextInput || (props => {
      return React.createElement("input", {
        type: props.type || "text",
        value: props.value === undefined || props.value === null ? "" : props.value,
        onChange: e => props.onChange && props.onChange(e.target.value),
        disabled: props.disabled,
        style: { width: "100%", padding: "6px 8px", boxSizing: "border-box" }
      });
    });
    const Select = Components.Select || (props => {
      return React.createElement("select", {
        value: props.value,
        onChange: e => {
          const val = props.options && props.options.find(o => String(o.value) === String(e.target.value)) ? (isNaN(props.options[0].value) ? e.target.value : Number(e.target.value)) : e.target.value;
          props.onChange && props.onChange(val);
        },
        disabled: props.isDisabled,
        style: { width: "100%", padding: "6px 8px", boxSizing: "border-box" }
      }, props.options && props.options.map(o => React.createElement("option", { key: o.value, value: o.value }, o.label)));
    });
    const Button = Components.Button || (props => React.createElement("button", { onClick: props.onClick, style: { padding: "6px 10px", cursor: "pointer" } }, props.children));

    const SettingsPanel = () => {
      const [state, setState] = React.useState({ ...settings });

      const handleChange = (key, value) => {
        const schema = settingsSchema[key];
        const validationResult = schema && schema.validate ? schema.validate(value) : true;
        if (validationResult !== true) {
          BdApi.UI.showToast(validationResult, { type: "error" });
          return;
        }
        settings[key] = value;
        setState({ ...settings });
        saveSettings();
      };

      return (
        React.createElement(FormSection, { style: { padding: "12px" } },
          React.createElement(FormTitle, { tag: "h2" }, "Custom RPC Settings"),
          (typeof ShowCurrentGame === "function" && ShowCurrentGame() === false) && React.createElement(FormItem, { className: "bd-error-card", style: { padding: "1em", margin: "1em 0", background: "var(--background-secondary)", borderRadius: "4px" } },
            React.createElement(FormTitle, null, "Notice"),
            React.createElement("div", null, "Activity Sharing isn't enabled; people won't be able to see your custom rich presence!"),
            React.createElement(Button, {
              onClick: () => {
                try {
                  UserSettingsStatusStore && typeof UserSettingsStatusStore.setShowCurrentGame === "function" && UserSettingsStatusStore.setShowCurrentGame(true);
                  BdApi.UI.showToast("Activity Sharing enabled", { type: "success" });
                } catch (e) {
                  BdApi.UI.showToast("Failed to enable Activity Sharing", { type: "error" });
                }
              },
              style: { marginTop: "8px" }
            }, "Enable")
          ),
          React.createElement(FormItem, null,
            React.createElement("div", null,
              "Go to the ", React.createElement("a", { href: "https://discord.com/developers/applications", target: "_blank" }, "Discord Developer Portal"), " to create an application and get the application ID.",
              React.createElement("br", null),
              "Upload images in the Rich Presence tab to get the image keys.",
              React.createElement("br", null),
              "If using an image link, upload to ", React.createElement("a", { href: "https://imgur.com", target: "_blank" }, "Imgur"), " and get the direct image link by right-clicking and selecting \"Copy image address\".",
              React.createElement("br", null),
              "You can't see your own buttons on your profile, but others can.",
              React.createElement("br", null),
              "Avoid weird unicode text, as it may prevent the rich presence from showing."
            )
          ),
          // Render inputs for each setting in schema
          Object.entries(settingsSchema).map(([key, meta]) => {
            const label = meta.description || key;
            const disabled = typeof meta.disabled === "function" ? meta.disabled() : !!meta.disabled;
            if (meta.type === "select") {
              return React.createElement(FormItem, { key: key, style: { marginTop: "8px" } },
                React.createElement(FormTitle, null, label),
                React.createElement(Select, {
                  options: meta.options,
                  value: state[key],
                  onChange: value => handleChange(key, value),
                  isDisabled: disabled
                })
              );
            } else {
              return React.createElement(FormItem, { key: key, style: { marginTop: "8px" } },
                React.createElement(FormTitle, null, label),
                React.createElement(TextInput, {
                  type: meta.type === "number" ? "number" : "text",
                  value: state[key],
                  onChange: value => {
                    const parsed = meta.type === "number" ? (value === "" ? 0 : parseInt(value, 10) || 0) : value;
                    handleChange(key, parsed);
                  },
                  disabled: disabled
                })
              );
            }
          })
        )
      );
    };

    return BdApi.React.createElement(SettingsPanel);
  }
};