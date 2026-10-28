// Release builds signed once, by gradle, with the release key (mobile-release.yml): when FLEETD_ANDROID_KEYSTORE names
// a keystore at `expo prebuild`, the release build type signs with it, its passwords and alias read from the
// environment as gradle runs (ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD). Without it, as
// Expo's template has it, a release build is debug-signed: installable, not for a store.
const { withAppBuildGradle } = require("expo/config-plugins");

const RELEASE = `        release {
            storeFile file(System.getenv("FLEETD_ANDROID_KEYSTORE"))
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("ANDROID_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_KEY_PASSWORD")
        }
`;

module.exports = (config) =>
  withAppBuildGradle(config, (c) => {
    if (!process.env.FLEETD_ANDROID_KEYSTORE) return c;
    let gradle = c.modResults.contents;
    const configs = /signingConfigs \{\n/u;
    const release = /(buildTypes \{[\s\S]*?release \{[\s\S]*?)signingConfig signingConfigs\.debug/u;
    if (!configs.test(gradle) || !release.test(gradle)) throw new Error("android-signing: build.gradle isn't Expo's template");
    gradle = gradle.replace(configs, (m) => m + RELEASE).replace(release, "$1signingConfig signingConfigs.release");
    c.modResults.contents = gradle;
    return c;
  });
