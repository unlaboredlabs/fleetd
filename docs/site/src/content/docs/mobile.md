---
title: Phone app
description: Chat with your Navis and projects and answer approvals from your phone. Build and sign it yourself, for iPhone and Android phones, on GitHub's runners, and update it over the air.
---

The phone app connects to your [hub](/docs/glossary#hub) as the desktop app does, with its own key. It shows your
[Navis](/docs/navi) and projects, with what needs you on top, their chats, live as the lead writes, and the
[approvals](/docs/approvals-and-secrets) waiting on you, each with everything it would do. Its notifications show the
full text, end-to-end encrypted. Settings, secrets and the hub's admin pages stay in the desktop app.

fleetd doesn't publish the app in Apple's or Google's stores yet. You build it from the repository on GitHub's
runners: no Expo account and no EAS.

## Pair it {#pair}

1. On the hub, run `fleetd pair` and keep the code it prints.
2. In the app, tap **Connect to a Hub** (or **Paste a Pairing Code**, with the code copied), enter the hub's address,
   such as `http://devbox:4790`, and the code. Tap **Connect**.

The key stays in the phone's secure storage (the Keychain on iOS, the Keystore on Android). **Disconnect**, in the
app's Settings tab, asks first,
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
3. The hub seals each notification to that key and sends the ciphertext through the
   [push relay](/docs/phone-notifications), `https://push.fleetd.sh` unless the hub sets another, which passes it
   to Apple or Google.
4. On the phone, the iOS notification extension or the Android app opens it and shows it.

**What the relay sees:** the phone's push token, the ciphertext's size, when it was sent and the hub's IP address.
Nothing readable: not the title, the text or which chat it is about. Apple and Google see the same, plus a generic
"fleetd: New activity" on iOS.

- A notification the phone can't open (another hub's key, a newer hub, a stranger with the token) shows only "fleetd:
  New activity" on iOS and nothing on Android.
- During the hub's quiet hours, it arrives without a sound. On iOS, an urgent one (money, irreversible commands) is
  time-sensitive and shows during a Focus.
- Android sorts them into channels, each of which you can mute in the system's settings: Chats, Approvals, Orders and
  alerts, Quiet hours. One notification per chat, replaced by the next.
- Tapping one opens its chat, or Approvals with that request on top.

The published app needs nothing set up: hubs send through push.fleetd.sh. An app you build yourself needs your own
relay and push credentials: an APNs key for your bundle id on the relay, and your Firebase project's
`google-services.json` for the Android build (below). See
[Run your own relay](/docs/phone-notifications#own).

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
changes, as macOS runners are scarce: the Android build bundles the same JavaScript, so a desktop change that breaks it
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
| `IOS_CERT_P12_BASE64` | `base64 < dist.p12` of an Apple Distribution certificate with its private key |
| `IOS_CERT_PASSWORD` | The `.p12`'s export password |
| `IOS_PROFILE_BASE64` | `base64 < fleetd.mobileprovision` of a distribution provisioning profile for the bundle id |
| `IOS_EXTENSION_PROFILE_BASE64` | The same, for the extension's id (`<bundle id>.notifications`) |
| `APPLE_TEAM_ID` | Your team's 10-character id |
| `ASC_KEY_ID`, `ASC_ISSUER_ID` | An Apple API key for TestFlight uploads (App Manager role): its id and issuer |
| `ASC_KEY_P8_BASE64` | `base64 < AuthKey_XXXX.p8` of that key |

Export the `.p12` from Keychain Access on the Mac that made the certificate's signing request: under **My
Certificates**, the Apple Distribution certificate with its private key under it. The build adds Apple's WWDR
intermediate certificates itself; your Mac needs them only to show the certificate as valid. A build that stops at
**Signing keychain** says whether the `.p12` lacked its private key or the certificate wasn't valid.

Set the repository variable `FLEETD_APP_ID` to your bundle id, such as `com.example.fleetd`: Apple ties a bundle id to
one team, so you can't sign `sh.fleetd.app`. Tick **Send the iOS build to TestFlight** to upload it. Without the App
Store Connect key, the signed `.ipa` is kept as the `fleetd-ios-release` artifact instead. Each run's number is the
build number, which every upload must raise.

## Over-the-air updates {#updates}

A build made with a code signing certificate updates its JavaScript over the air: its screens, chats and approvals.
A native change, such as a new native module or an Expo SDK upgrade, still needs a new build. A build without a
certificate takes no updates and changes only when you install a new one. The workflows' builds have no certificate
until you [set one up](#own-updates).

1. On every fleetd release, the release workflow (`build-release.yml`) exports the app's JavaScript, signs a
   manifest for each platform with the code signing key, and puts them on the release as `mobile-updates.tar.gz`.
2. fleetd.sh unpacks them and serves them at `https://fleetd.sh/updates`. It picks the manifest by the headers the app
   sends: its channel (`expo-channel-name`), its runtime version (`expo-runtime-version`) and its platform
   (`expo-platform`).
3. The app checks when it starts and runs a new bundle from its next start. It loads only a bundle signed with its
   certificate's key and made for its runtime version. Anything else, or no answer, leaves it on the bundle it has.

The runtime version is a fingerprint of the app's native side and its build settings. A build whose native code
differs gets a different one, so it never loads a bundle made for another. **Mobile release** fails a build with a
certificate whose runtime version isn't the one releases publish its commit's updates for.

### Channels {#channels}

Pick a build's channel with **Which over-the-air updates the build takes** when you run **Mobile release**.

| Channel | Updates from |
|---|---|
| `edge` | Every merge to `main`, with the [Edge](/docs/updating-and-uninstall#channels) release. A merge that leaves the JavaScript as it was publishes nothing new. |
| `stable` | Each tagged release. |

### Publish your own {#own-updates}

A fork signs its own updates and serves them from its own address. Builds with your certificate reject updates
signed with any other key, so they take none from fleetd.sh.

1. Make a key and a certificate once, in `app/mobile` of your fork's checkout, with Node.js 24:

   ```sh
   npm ci
   npm exec -- expo-updates codesigning:generate --key-output-directory keys --certificate-output-directory certs --certificate-validity-duration-years 10 --certificate-common-name "My fleetd"
   ```

   git ignores both files (`*.pem`). Keep the key safe: builds made with the certificate trust only it. Skip the
   `codesigning:configure` it suggests; the workflows pass the certificate to the build.
2. In your fork's Settings › Secrets and variables › Actions, set:

   | Name | Kind | Value |
   |---|---|---|
   | `UPDATES_PRIVATE_KEY_PEM` | Secret | The contents of `keys/private-key.pem` |
   | `UPDATES_CERT_PEM` | Variable | The contents of `certs/certificate.pem` |
   | `FLEETD_UPDATES_URL` | Variable | Your site's update URL, such as `https://fleetd.example.com/updates` |
   | `SITE_DEPLOY_HOOK` | Secret | Optional: a Vercel deploy hook for your site, so a release's updates go live when it's out, not with the site's next deploy |

3. Serve them: deploy your fork's `site/` to Vercel as its `README.md` says. Its build fetches the updates from your
   fork's releases, and its `vercel.json` routes the app's requests. Another host works too if it serves
   `updates/<channel>/<runtime version>/<platform>` from the unpacked tarballs for those three headers, with the
   response headers `vercel.json` sets.
4. Run **Mobile release** for builds with your certificate. Each release from then on publishes their updates.

A release without the key publishes no updates and passes. The update URL, the channel and the certificate are fixed
when the app is built: a build you already installed keeps asking where it was built to ask.

## Not yet {#not-yet}

- Secrets, settings and taking over a browser session: use the desktop app.
