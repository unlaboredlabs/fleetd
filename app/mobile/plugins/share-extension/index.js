// The iOS Share Extension (ShareViewController.swift): "fleetd" in the share sheet of Safari, Photos and any other app,
// which sends text, a link or images into a chosen chat. Added at `expo prebuild` as the native projects are, never
// kept in git: its target in the Xcode project, embedded in the app, with its sources, Info.plist and entitlements.
// It reads the paired hub from the keychain access group the app shares with its extensions (src/vault.ts,
// plugins/notification-service), and keeps no copy. The extension's bundle id is the app's plus ".share"; a signed
// build needs a provisioning profile for it (docs: mobile.md).
const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withEntitlementsPlist, withXcodeProject } = require("expo/config-plugins");

const TARGET = "FleetdShare";
const SOURCES = ["ShareViewController.swift", "ShareView.swift", "ShareModel.swift", "HubLink.swift", "Shared.swift"];
const EMBED = "Embed Foundation Extensions";

// The group the app's secure storage writes to (its first), named for the notification key it held first.
const keychainGroup = (appId) => `$(AppIdentifierPrefix)${appId}.push`;

const plist = (entries) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries}
</dict>
</plist>
`;

/** Shown in the share sheet for text, one web page or up to 20 images (the hub's ATTACHMENTS_MAX). */
const IMAGES_MAX = 20;

// The app's version and build, as Expo writes them into the app's own Info.plist: an extension must carry the same.
const infoPlist = (version, build) =>
  plist(`  <key>CFBundleDevelopmentRegion</key><string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key><string>fleetd</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${build}</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsArbitraryLoads</key><true/></dict>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionAttributes</key>
    <dict>
      <key>NSExtensionActivationRule</key>
      <dict>
        <key>NSExtensionActivationSupportsText</key><true/>
        <key>NSExtensionActivationSupportsWebURLWithMaxCount</key><integer>1</integer>
        <key>NSExtensionActivationSupportsImageWithMaxCount</key><integer>${IMAGES_MAX}</integer>
      </dict>
    </dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.share-services</string>
    <key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).ShareViewController</string>
  </dict>`);

/** The extension's target, by its name, which the project may keep quoted (pbxTargetByName misses it then). */
const findTarget = (project) =>
  Object.values(project.pbxNativeTargetSection()).find((t) => typeof t === "object" && String(t.name).replace(/^"|"$/gu, "") === TARGET);

/**
 * Adds the extension's target to the app's Xcode project, embedded in the app, once. Its product goes in the app's
 * one embedding phase, shared with the notification extension whichever plugin made it first.
 */
const addShareTarget = (project, appId) => {
  if (findTarget(project) !== undefined) return;
  const app = project.getFirstTarget();
  const configurations = project.pbxXCBuildConfigurationSection();
  const appList = project.pbxXCConfigurationList()[app.firstTarget.buildConfigurationList];
  const appSettings = configurations[appList.buildConfigurations[0].value].buildSettings;

  // The library expects these sections to exist when it links the extension to the app.
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};

  // The target, its product in a new Copy Files phase of the app (to PlugIns) and the app depending on it.
  const target = project.addTarget(TARGET, "app_extension", TARGET, `${appId}.share`);
  const group = project.addPbxGroup(SOURCES, TARGET, TARGET);
  project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
  project.addBuildPhase(SOURCES, "PBXSourcesBuildPhase", "Sources", target.uuid);
  project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
  project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);

  for (const key of Object.keys(configurations)) {
    const settings = configurations[key].buildSettings;
    if (settings?.PRODUCT_NAME !== `"${TARGET}"`) continue;
    Object.assign(settings, {
      INFOPLIST_FILE: `${TARGET}/Info.plist`,
      CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
      CODE_SIGN_STYLE: "Automatic",
      // The app's, else the project's.
      ...(appSettings.IPHONEOS_DEPLOYMENT_TARGET === undefined ? {} : { IPHONEOS_DEPLOYMENT_TARGET: appSettings.IPHONEOS_DEPLOYMENT_TARGET }),
      TARGETED_DEVICE_FAMILY: '"1,2"',
      SWIFT_VERSION: "5.0",
      GENERATE_INFOPLIST_FILE: "NO",
      CLANG_ENABLE_MODULES: "YES",
    });
  }

  // The embedding right after the app's resources, before its script phases: after them, Xcode finds a cycle. When
  // the app has its embedding phase already, the product moves into it and the new phase goes.
  const phases = app.firstTarget.buildPhases;
  const copy = objects.PBXCopyFilesBuildPhase;
  const added = phases.findIndex((p) => p.comment === "Copy Files");
  const [phase] = phases.splice(added, 1);
  const embed = phases.find((p) => p.comment === EMBED);
  if (embed !== undefined) {
    copy[embed.value].files.push(...copy[phase.value].files);
    delete copy[phase.value];
    delete copy[`${phase.value}_comment`];
    return;
  }
  phases.splice(phases.findIndex((p) => p.comment === "Resources") + 1, 0, { ...phase, comment: EMBED });
  copy[phase.value].name = `"${EMBED}"`;
  copy[`${phase.value}_comment`] = EMBED;
};

const withShareExtension = (config) => {
  const appId = config.ios?.bundleIdentifier;
  if (appId === undefined) throw new Error("share-extension: the app has no ios.bundleIdentifier");

  // The app: the shared keychain group first, where secure storage writes by default.
  config = withEntitlementsPlist(config, (c) => {
    const groups = c.modResults["keychain-access-groups"] ?? [];
    if (!groups.includes(keychainGroup(appId))) c.modResults["keychain-access-groups"] = [keychainGroup(appId), ...groups];
    return c;
  });

  config = withDangerousMod(config, [
    "ios",
    (c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, TARGET);
      fs.mkdirSync(dir, { recursive: true });
      for (const file of SOURCES) fs.copyFileSync(path.join(__dirname, file), path.join(dir, file));
      fs.writeFileSync(path.join(dir, "Info.plist"), infoPlist(c.version ?? "1.0.0", c.ios?.buildNumber ?? "1"));
      fs.writeFileSync(
        path.join(dir, `${TARGET}.entitlements`),
        plist(`  <key>keychain-access-groups</key>\n  <array><string>${keychainGroup(appId)}</string></array>`),
      );
      return c;
    },
  ]);

  return withXcodeProject(config, (c) => {
    addShareTarget(c.modResults, appId);
    return c;
  });
};

module.exports = withShareExtension;
module.exports.addShareTarget = addShareTarget;
module.exports.findTarget = findTarget;
module.exports.TARGET = TARGET;
module.exports.SOURCES = SOURCES;
