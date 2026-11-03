// fleetd's Shortcuts actions (Intents.swift; D289 mobile.shortcuts), added at `expo prebuild` as the native projects
// are, never kept in git: their sources in the app's own target, beside its AppDelegate, so they need no extension, App
// ID or provisioning profile of their own, and Xcode's App Intents metadata step finds them in the app. They reach the
// hub as the share sheet does, with its link and decisions (plugins/share-extension's HubLink.swift and Shared.swift,
// built into the app too), reading the pairing from the keychain group the app writes it to. At launch the app tells
// iOS to list its App Shortcuts again, so the chats' own ones ("Open Inbox in fleetd") follow the hub's.
const fs = require("node:fs");
const path = require("node:path");
const { IOSConfig, withAppDelegate, withDangerousMod, withXcodeProject } = require("expo/config-plugins");

/** Each source, by where it lives here. */
const SOURCES = {
  "Intents.swift": __dirname,
  "Actions.swift": __dirname,
  "HubLink.swift": path.join(__dirname, "../share-extension"),
  "Shared.swift": path.join(__dirname, "../share-extension"),
};

const LAUNCHED = "return super.application(application, didFinishLaunchingWithOptions: launchOptions)";
const REFRESH = "if #available(iOS 18.0, *) { FleetdShortcuts.updateAppShortcutParameters() }";

/** The AppDelegate with the refresh before its launch returns, once; it throws where that line isn't. */
const withRefresh = (contents) => {
  if (contents.includes(REFRESH)) return contents;
  if (!contents.includes(LAUNCHED)) throw new Error("app-intents: the AppDelegate has no `" + LAUNCHED + "`");
  return contents.replace(LAUNCHED, `// fleetd's App Shortcuts, listed again for the chats and automations they name (plugins/app-intents).\n    ${REFRESH}\n    ${LAUNCHED}`);
};

/** Adds each source to the app's group and its target, once (a file the group has already is skipped). */
const addSources = (project, projectName) => {
  for (const file of Object.keys(SOURCES)) {
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath: `${projectName}/${file}`, groupName: projectName, project });
  }
};

const withAppIntents = (config) => {
  config = withDangerousMod(config, [
    "ios",
    (c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, c.modRequest.projectName);
      fs.mkdirSync(dir, { recursive: true });
      for (const [file, from] of Object.entries(SOURCES)) fs.copyFileSync(path.join(from, file), path.join(dir, file));
      return c;
    },
  ]);
  config = withAppDelegate(config, (c) => {
    if (c.modResults.language !== "swift") throw new Error("app-intents: the AppDelegate isn't Swift");
    c.modResults.contents = withRefresh(c.modResults.contents);
    return c;
  });
  return withXcodeProject(config, (c) => {
    addSources(c.modResults, c.modRequest.projectName);
    return c;
  });
};

module.exports = withAppIntents;
module.exports.addSources = addSources;
module.exports.withRefresh = withRefresh;
module.exports.SOURCES = SOURCES;
