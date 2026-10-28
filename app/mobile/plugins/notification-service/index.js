// The iOS Notification Service Extension (NotificationService.swift), added at `expo prebuild` as the native projects
// are, never kept in git: its target in the Xcode project, embedded in the app, with its sources, Info.plist and
// entitlements. The app and the extension share one keychain access group, the first (so the default) of each, where
// the app keeps the phone's notification key (src/vault.ts) and the extension reads it. The extension's bundle id is
// the app's plus ".notifications"; a signed build needs a provisioning profile for each (docs: mobile.md).
const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withEntitlementsPlist, withXcodeProject } = require("expo/config-plugins");

const TARGET = "FleetdNotifications";
const SOURCES = ["NotificationService.swift", "Sealed.swift"];

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

// The app's version and build, as Expo writes them into the app's own Info.plist: an extension must carry the same.
const infoPlist = (version, build) =>
  plist(`  <key>CFBundleDevelopmentRegion</key><string>$(DEVELOPMENT_LANGUAGE)</string>
  <key>CFBundleDisplayName</key><string>fleetd notifications</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${build}</string>
  <key>NSExtension</key>
  <dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.usernotifications.service</string>
    <key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).NotificationService</string>
  </dict>`);

const withNotificationService = (config) => {
  const appId = config.ios?.bundleIdentifier;
  if (appId === undefined) throw new Error("notification-service: the app has no ios.bundleIdentifier");

  // The app: the shared keychain group, and time-sensitive notifications for urgent ones.
  config = withEntitlementsPlist(config, (c) => {
    c.modResults["keychain-access-groups"] = [keychainGroup(appId)];
    c.modResults["com.apple.developer.usernotifications.time-sensitive"] = true;
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
    const project = c.modResults;
    if (project.pbxTargetByName(TARGET) != null) return c;
    const app = project.getFirstTarget();
    const configurations = project.pbxXCBuildConfigurationSection();
    const appList = project.pbxXCConfigurationList()[app.firstTarget.buildConfigurationList];
    const appSettings = configurations[appList.buildConfigurations[0].value].buildSettings;

    // The library expects these sections to exist when it links the extension to the app.
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency ??= {};
    objects.PBXContainerItemProxy ??= {};

    // The target, its product embedded in the app (a Copy Files phase to PlugIns) and the app depending on it.
    const target = project.addTarget(TARGET, "app_extension", TARGET, `${appId}.notifications`);
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

    // The embedding right after the app's resources, before its script phases: after them, Xcode finds a cycle.
    const phases = app.firstTarget.buildPhases;
    const embed = phases.findIndex((p) => p.comment === "Copy Files");
    const [phase] = phases.splice(embed, 1);
    phases.splice(phases.findIndex((p) => p.comment === "Resources") + 1, 0, { ...phase, comment: "Embed Foundation Extensions" });
    const copy = project.hash.project.objects.PBXCopyFilesBuildPhase;
    copy[phase.value].name = '"Embed Foundation Extensions"';
    copy[`${phase.value}_comment`] = "Embed Foundation Extensions";
    return c;
  });
};

module.exports = withNotificationService;
