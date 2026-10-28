---
title: Phone app
description: Chat with your Navis and projects and answer approvals from your phone. Build and sign the iOS and Android app yourself on GitHub's runners.
---

The phone app connects to your [hub](/docs/glossary#hub) as the desktop app does, with its own key. It shows your
[Navis](/docs/navi) and projects, with what needs you on top, their chats, live as the lead writes, and the
[approvals](/docs/approvals-and-secrets) waiting on you, each with everything it would do. Settings, secrets and the
hub's admin pages stay in the desktop app.

fleetd doesn't publish the app to the App Store or Google Play yet. You build it from the repository on GitHub's
runners: no Expo account and no EAS.

## Pair it {#pair}

1. On the hub, run `fleetd pair` and keep the code it prints.
2. In the app, enter the hub's address, such as `http://devbox:4790`, and the code. Tap **Pair**.

The key stays in the phone's secure storage (the Keychain on iOS, the Keystore on Android). **Disconnect** forgets it.

Hubs on a tailnet often answer plain HTTP. The app allows that on both platforms, so turn Tailscale on in the phone
and use the hub's tailnet name or address.

## Build it on GitHub {#build}

1. Fork [unlaboredlabs/fleetd](https://github.com/unlaboredlabs/fleetd) and enable Actions on your fork.
2. Open Actions › **Mobile** › **Run workflow**.
3. When it finishes, download the run's artifacts:

| Artifact | What it is |
|---|---|
| `fleetd-android-apk` | A release APK, debug-signed. Open it on an Android phone, or `adb install app-release.apk`. |
| `fleetd-ios-simulator` | The app for the iOS simulator. Unzip it and `xcrun simctl install booted fleetd.app`. |

The workflow runs `expo prebuild`, then gradle on an Ubuntu runner and xcodebuild on a macOS runner. On pull
requests it builds only when `app/mobile` changes, and the iOS build only then too: macOS runners are scarce.

An iPhone runs only signed apps, so for a real iPhone you need the signed build below.

## Signed builds {#signing}

Open Actions › **Mobile release** › **Run workflow**. Each platform signs only when its secrets are set
(Settings › Secrets and variables › Actions). Without them, Android gets a debug-signed APK and iOS is skipped.

### Android {#android}

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 < release.jks` of your keystore |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore's password |
| `ANDROID_KEY_ALIAS` | The key's alias |
| `ANDROID_KEY_PASSWORD` | The key's password |

Make a keystore once with
`keytool -genkeypair -v -keystore release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias fleetd`, and keep it:
updates to an installed app must be signed with the same key. The `fleetd-android-release` artifact holds a signed
APK and an app bundle (`.aab`) for Google Play.

### iOS and TestFlight {#ios}

You need a paid Apple Developer account and an app id for the bundle id you pick.

| Secret | Value |
|---|---|
| `IOS_CERT_P12_BASE64` | `base64 < dist.p12` of an Apple Distribution certificate with its key |
| `IOS_CERT_PASSWORD` | The `.p12`'s export password |
| `IOS_PROFILE_BASE64` | `base64 < fleetd.mobileprovision` of an App Store provisioning profile for the bundle id |
| `APPLE_TEAM_ID` | Your team's 10-character id |
| `ASC_KEY_ID`, `ASC_ISSUER_ID` | An App Store Connect API key (App Manager role): its id and issuer |
| `ASC_KEY_P8_BASE64` | `base64 < AuthKey_XXXX.p8` of that key |

Set the repository variable `FLEETD_APP_ID` to your bundle id, such as `com.example.fleetd`: Apple ties a bundle id to
one team, so you can't sign `sh.fleetd.app`. Tick **Send the iOS build to TestFlight** to upload it. Without the App
Store Connect key, the signed `.ipa` is kept as the `fleetd-ios-release` artifact instead. Each run's number is the
build number, which every upload must raise.

### Over-the-air updates {#updates}

Builds take JavaScript updates over the air only when you set the repository variable `UPDATES_CERT_PEM` to a code
signing certificate. The app then loads only bundles signed with its key, for its own native build, from the channel
you pick when you run the workflow (Edge or Stable). Without it, the app takes no updates and changes only when you
install a new build.

## Not yet {#not-yet}

- Notifications. The hub and relay side is in [Phone notifications](/docs/phone-notifications); the app doesn't register for them yet.
- Secrets, settings and taking over a browser session: use the desktop app.
