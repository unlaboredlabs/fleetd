// The app's Expo config. Native projects are generated from it (`expo prebuild`) on each build, never kept in git.
//
// Hubs are often plain HTTP on a tailnet, at any address, so cleartext is allowed everywhere: ATS's arbitrary loads on
// iOS, usesCleartextTraffic on Android. The key goes over that link as the desktop app's does.
//
// Builds read these from the environment:
// - FLEETD_APP_ID: the bundle id and Android package (default sh.fleetd.app). A self-built, signed app needs its own:
//   an Apple team can't sign another's id.
// - FLEETD_BUILD_NUMBER: the build's number (CFBundleVersion, versionCode), which each store upload must raise; the
//   release workflow uses its run number.
// - FLEETD_UPDATES_CERT: a code signing certificate (PEM) for over-the-air updates (D219). Without it the app takes no
//   updates at all: an unsigned bundle is never loaded. FLEETD_UPDATES_CHANNEL (edge or stable, default edge) picks
//   the static manifests published alongside fleetd's releases, per runtime version and platform.
import { relative, resolve } from "node:path";
import type { ConfigContext, ExpoConfig } from "expo/config";

const appId = process.env.FLEETD_APP_ID || "sh.fleetd.app";
const updatesCert = process.env.FLEETD_UPDATES_CERT || undefined;
const build = /^\d+$/u.test(process.env.FLEETD_BUILD_NUMBER ?? "") ? process.env.FLEETD_BUILD_NUMBER : undefined;
const channel = process.env.FLEETD_UPDATES_CHANNEL === "stable" ? "stable" : "edge";

/** The manifests' home: one URL per channel, which serves by the request's expo-runtime-version and expo-platform. */
export const UPDATES_URL = `https://fleetd.sh/updates/${channel}`;

export default ({ projectRoot }: ConfigContext): ExpoConfig => ({
  name: "fleetd",
  slug: "fleetd",
  scheme: "fleetd",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "dark",
  backgroundColor: "#1c1c1b",
  // A bundle runs only on the native build it was made for: the fingerprint changes with any native dependency.
  runtimeVersion: { policy: "fingerprint" },
  updates: updatesCert
    ? {
        enabled: true,
        url: UPDATES_URL,
        checkAutomatically: "ON_LOAD",
        fallbackToCacheTimeout: 0,
        // Expo reads it relative to the project.
        codeSigningCertificate: relative(projectRoot, resolve(updatesCert)),
        codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
      }
    : { enabled: false },
  ios: {
    bundleIdentifier: appId,
    ...(build === undefined ? {} : { buildNumber: build }),
    supportsTablet: true,
    infoPlist: {
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true },
      NSLocalNetworkUsageDescription: "fleetd connects to your hub on your network.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: appId,
    ...(build === undefined ? {} : { versionCode: Number(build) }),
    adaptiveIcon: {
      backgroundColor: "#1c1c1b",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: ["expo-secure-store", ["expo-build-properties", { android: { usesCleartextTraffic: true } }]],
});
