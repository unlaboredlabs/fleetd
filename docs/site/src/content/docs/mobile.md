---
title: Phone app
description: Chat with your Navis and projects and answer approvals from your phone. Build and sign it yourself, for iPhone and Android phones, on GitHub's runners.
---

The phone app connects to your [hub](/docs/glossary#hub) as the desktop app does, with its own key. It shows your
[Navis](/docs/navi) and projects, with what needs you on top, their chats, live as the lead writes, and the
[approvals](/docs/approvals-and-secrets) waiting on you, each with everything it would do. Its notifications show the
full text, end-to-end encrypted. Settings, secrets and the hub's admin pages stay in the desktop app.

fleetd doesn't publish the app in Apple's or Google's stores yet. You build it from the repository on GitHub's
runners: no Expo account and no EAS.

## Pair it {#pair}

1. On the hub, run `fleetd pair` and keep the code it prints.
2. In the app, enter the hub's address, such as `http://devbox:4790`, and the code. Tap **Pair**.

The key stays in the phone's secure storage (the Keychain on iOS, the Keystore on Android). **Disconnect** asks first,
then signs the phone out on the hub, which revokes its key and stops its notifications, and forgets the hub. If the hub
can't be reached, you can forget it anyway and sign the phone out later under Settings › You in the desktop app.

Hubs on a tailnet often answer plain HTTP. The app allows that on both platforms, so turn Tailscale on in the phone
and use the hub's tailnet name or address.

## Notifications {#notifications}

The first time the app connects, it asks to send notifications. They show what happened in full: a Navi's reply, a
lead's message, an approval waiting for you, an order that landed or stopped.

1. When you pair, the phone makes its own key pair. The secret key never leaves the phone: on iOS it is in the
   Keychain, shared only with the app's notification extension; on Android, in storage encrypted with a Keystore key.
2. The app registers the phone's push token, from Apple's or Google's own push service (not Expo's), and its public
   key with the hub. It registers again whenever the phone gets a new token.
3. The hub seals each notification to that key and sends the ciphertext through your
   [push relay](/docs/phone-notifications), which passes it to Apple or Google.
4. On the phone, the iOS notification extension or the Android app opens it and shows it.

**What the relay sees:** the phone's push token, the ciphertext and its size. Nothing readable: not the title, the
text or which chat it is about. Apple and Google see the same, plus a generic "fleetd: New activity" on iOS.

- A notification the phone can't open (another key, a newer hub) shows "fleetd: New activity".
- During the hub's quiet hours, it arrives without a sound. On iOS, an urgent one (money, irreversible commands) is
  time-sensitive and shows during a Focus.
- Android sorts them into channels, each of which you can mute in the system's settings: Chats, Approvals, Orders and
  alerts, Quiet hours. One notification per chat, replaced by the next.
- Tapping one opens its chat, or Approvals with that request on top.

The hub needs a relay set, and the app needs your push credentials when you build it: an APNs key for your bundle id
on the relay, and for Android your Firebase project's `google-services.json` (below).

## Build it on GitHub {#build}

1. Fork [unlaboredlabs/fleetd](https://github.com/unlaboredlabs/fleetd) and enable Actions on your fork.
2. Open Actions › **Mobile** › **Run workflow**.
3. When it finishes, download the run's artifacts:

| Artifact | What it is |
|---|---|
| `fleetd-android-apk` | A release APK, debug-signed. Open it on an Android phone, or `adb install app-release.apk`. |
| `fleetd-ios-simulator` | The app for the iOS simulator. Unzip it and `xcrun simctl install booted fleetd.app`. |

The workflow runs `expo prebuild`, then gradle on an Ubuntu runner and xcodebuild on a macOS runner. On pull requests
and on `main`, the app's checks and the Android build run when `app/mobile`, the workflow, or a desktop module the app
imports (`app/mobile/src/desktop.ts` lists them) changes. The iOS build runs only when `app/mobile` or the workflow
changes, as macOS runners are scarce: the same JavaScript is bundled for Android, so a desktop change that breaks it
fails there.

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
updates to an installed app must be signed with the same key. Gradle signs the release build with it, so the
`fleetd-android-release` artifact holds an APK and an app bundle (`.aab`) for Google's store, each signed once, with
your key only.

For notifications, register the app (its package, `FLEETD_APP_ID`) in a Firebase project and set the repository
variable `GOOGLE_SERVICES_JSON` to the contents of its `google-services.json`. Without it, the app builds and runs but
gets no notifications.

### iOS and TestFlight {#ios}

You need a paid Apple Developer account and two app ids: one for the bundle id you pick, with the Push Notifications
and Time Sensitive Notifications capabilities, and one for its notification extension, the same id plus
`.notifications`.

| Secret | Value |
|---|---|
| `IOS_CERT_P12_BASE64` | `base64 < dist.p12` of an Apple Distribution certificate with its key |
| `IOS_CERT_PASSWORD` | The `.p12`'s export password |
| `IOS_PROFILE_BASE64` | `base64 < fleetd.mobileprovision` of a distribution provisioning profile for the bundle id |
| `IOS_EXTENSION_PROFILE_BASE64` | The same, for the extension's id (`<bundle id>.notifications`) |
| `APPLE_TEAM_ID` | Your team's 10-character id |
| `ASC_KEY_ID`, `ASC_ISSUER_ID` | An Apple API key for TestFlight uploads (App Manager role): its id and issuer |
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

- Secrets, settings and taking over a browser session: use the desktop app.
