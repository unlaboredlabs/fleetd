// The app imports the desktop app's pure modules (src/desktop.ts), so Metro watches those folders too. They import no
// packages but React (the updates flow's store); were one to, it would resolve from this app's node_modules, as
// app/desktop's may not be installed.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const desktop = path.resolve(__dirname, "../desktop/src");
config.watchFolders = [
  path.join(desktop, "shared"),
  path.join(desktop, "renderer/src/data"),
  path.join(desktop, "renderer/screens/navi"),
  path.join(desktop, "renderer/screens/updates"),
];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];

module.exports = config;
