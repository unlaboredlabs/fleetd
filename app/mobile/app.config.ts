// The app's Expo config. Native projects are generated from it (`expo prebuild`) on each build, never kept in git.
//
// Hubs are often plain HTTP on a tailnet, at any address, so cleartext is allowed everywhere: ATS's arbitrary loads on
// iOS (scripts/ats.ts checks nothing cancels it), usesCleartextTraffic on Android. The key goes over that link as the
// desktop app's does.
//
// Builds read these from the environment:
// - FLEETD_APP_ID: the bundle id and Android package (default sh.fleetd.app). A self-built, signed app needs its own:
//   an Apple team can't sign another's id.
// - FLEETD_BUILD_NUMBER: the build's number (CFBundleVersion, versionCode), which each store upload must raise; the
//   release workflow uses its run number.
// - FLEETD_UPDATES_CERT: a code signing certificate (PEM) for over-the-air updates (D219). Without it the app takes no
//   updates at all: an unsigned bundle is never loaded. FLEETD_UPDATES_CHANNEL (edge or stable, default edge) is the
//   expo-channel-name it asks FLEETD_UPDATES_URL (default https://fleetd.sh/updates; a fork with its own certificate
//   sets its own) for, with its runtime version and platform: scripts/updates.ts writes those manifests on each
//   release, and site/vercel.json routes the headers to them.
// - FLEETD_GOOGLE_SERVICES_FILE: the Firebase project's google-services.json, for FCM on Android. Without it the app
//   builds and runs, and gets no notifications: Android gives it no push token.
// - FLEETD_ANDROID_KEYSTORE: a keystore that signs release builds (plugins/android-signing.js), else debug-signed.
//
// The runtime version is the native fingerprint, which takes in this config (not the build number): the release's
// update job (build-release.yml) resolves it with the same settings, so a build gets only bundles made for it, and a
// native change, or another URL or channel, gives builds a runtime version older bundles don't match.
//
// `scheme` registers fleetd:// links: a pairing QR code (`fleetd://pair?hub=…&code=…`) scanned with iOS's Camera opens
// the app, which pairs with it.
//
// Notifications use the platforms' own push, APNs and FCM, through `fleetd push-relay`, never Expo's push service
// (docs/design/push.md). The iOS Notification Service Extension that opens them comes from plugins/notification-service.
import { relative, resolve } from "node:path";
import type { ConfigContext, ExpoConfig } from "expo/config";

const appId = process.env.FLEETD_APP_ID || "sh.fleetd.app";
const updatesCert = process.env.FLEETD_UPDATES_CERT || undefined;
const build = /^\d+$/u.test(process.env.FLEETD_BUILD_NUMBER ?? "") ? process.env.FLEETD_BUILD_NUMBER : undefined;
const channel = process.env.FLEETD_UPDATES_CHANNEL === "stable" ? "stable" : "edge";
const updatesUrl = process.env.FLEETD_UPDATES_URL || "https://fleetd.sh/updates";
const googleServices = process.env.FLEETD_GOOGLE_SERVICES_FILE || undefined;

export default ({ projectRoot }: ConfigContext): ExpoConfig => ({
  name: "fleetd",
  slug: "fleetd",
  scheme: "fleetd",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  // Light and dark follow the phone's setting; App.tsx sets the root view's color to match (expo-system-ui).
  userInterfaceStyle: "automatic",
  backgroundColor: "#000000",
  // tsconfig.json's `paths` are for the typechecker alone (the desktop modules find React's types there): Metro
  // resolves React itself (metro.config.js).
  experiments: { tsconfigPaths: false },
  // A bundle runs only on the native build it was made for: the fingerprint changes with any native dependency.
  runtimeVersion: { policy: "fingerprint" },
  updates: updatesCert
    ? {
        enabled: true,
        url: updatesUrl,
        requestHeaders: { "expo-channel-name": channel },
        checkAutomatically: "ON_LOAD",
        fallbackToCacheTimeout: 0,
        // Expo reads it relative to the project.
        codeSigningCertificate: relative(projectRoot, resolve(updatesCert)),
        codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
      }
    : { enabled: false },
  ios: {
    bundleIdentifier: appId,
    // iOS 18's appearances; every icon is rendered from fleetd's mark (site/icon.svg) by `npm run icons`.
    icon: { light: "./assets/icon.png", dark: "./assets/icon-dark.png", tinted: "./assets/icon-tinted.png" },
    ...(build === undefined ? {} : { buildNumber: build }),
    supportsTablet: true,
    infoPlist: {
      // Arbitrary loads alone: NSAllowsLocalNetworking, NSAllowsArbitraryLoadsForMedia or
      // NSAllowsArbitraryLoadsInWebContent would make iOS ignore it, and an exception domain overrides it for its hosts.
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      NSLocalNetworkUsageDescription: "fleetd connects to your hub on your network.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: appId,
    ...(build === undefined ? {} : { versionCode: Number(build) }),
    adaptiveIcon: {
      backgroundColor: "#1b1c1f",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
    ...(googleServices === undefined ? {} : { googleServicesFile: relative(projectRoot, resolve(googleServices)) }),
  },
  plugins: [
    "expo-secure-store",
    ["expo-build-properties", { android: { usesCleartextTraffic: true } }],
    // A signed build is a store's (TestFlight, the App Store), whose APNs is production; the relay picks the matching one.
    ["expo-notifications", { mode: "production", icon: "./assets/notification-icon.png", color: "#6ea8fe", defaultChannel: "other" }],
    // The mark on a plain ground, white or black as the phone is.
    ["expo-splash-screen", { image: "./assets/splash-icon.png", imageWidth: 112, backgroundColor: "#ffffff", dark: { image: "./assets/splash-icon.png", backgroundColor: "#000000" } }],
    // Scans the hub's pairing QR code (D232); no recording, so no microphone.
    ["expo-camera", { cameraPermission: "fleetd scans the QR code your hub shows, to pair this phone with it, and takes photos you send in a chat.", microphonePermission: false, recordAudioAndroid: false }],
    // Photos and files sent in a chat go to your hub (attachment_put). No microphone: no video with sound.
    ["expo-image-picker", { photosPermission: "fleetd sends the photos you pick to a chat on your hub.", cameraPermission: "fleetd takes photos you send in a chat.", microphonePermission: false }],
    "./plugins/notification-service",
    "./plugins/android-signing",
  ],
});
