---
title: Phone app
description: Chat with your bots, answer approvals and take over screens from your phone, and build the app yourself.
---

This page is for using fleetd from your phone, and building the app.

The phone app shows your bots with what needs you on top, their chats as the lead writes, and approvals you answer
from their card. Secrets, people and most workspace settings stay in the desktop app.

## Pair it {#pair}

1. In the desktop app, open **Settings › Workspaces & devices** and click **Pair a phone**. Or run `fleetd pair` on the workspace.
   Either shows a QR code.
2. In the phone app, tap **Scan QR Code** and point the camera at it.

No camera? Tap **Enter Code Manually**, enter the workspace's address (such as `http://devbox:4790`) and the code, then tap
**Connect**. The code works once, for 15 minutes.

The phone must reach the workspace. On a tailnet, turn Tailscale on in the phone and use the workspace's tailnet name.

To sign the phone out, tap **Disconnect** at the end of Settings.

## Chats {#chats}

- **Pin** a chat: swipe it right and tap the pin, or hold it and pick **Pin**. Up to nine pins sit on top.
- **Archive** a chat: hold it and pick **Archive**.
- **Stop** the lead: while it works, the send button is **Stop**.
- **New bot**: tap **+** at the top of Chats.

Your pins are kept on the workspace, so they're the same on each of your phones.

### Sections {#sections}

Group chats under names of your own: hold a chat, pick **Move to Section…**, then a section or **New Section…**. Tap
a section's label to fold it; hold it to rename, move or remove it. Sections are the same in the desktop app.

## A bot's page {#manage}

Tap **ⓘ** at the top of a chat for its bot's page:

- Its icon and name.
- **Agents**: the lead and agents at work, open orders, the to-do list and recent merges.
- **Who merges** and how it merges ([merge train](/docs/merge-train)).
- Approvals, payments, skills and **Artifacts**.
- **New Screen**, **Forget Sign-ins…**, **Archive Bot** and **Delete Bot**.

## Screens {#screens}

When an agent needs you on its [screen](/docs/browser-sessions) (a captcha, a bank's check, a sign-in), you get a
notification and a card in the chat. Tap **Open**.

1. Tap **Take Over**. Then a tap clicks, a drag scrolls, and a long press drags.
2. Use the keyboard button to type.
3. Tap **Hand Back** when done.

Pinch to zoom. In a browser you control, tap the site at the top to type an address.

A phone screen shows inside its own device, in 3D: an iPhone Duo folds and opens with its simulator. While you watch,
drag it to turn it; it turns back when you let go. While you control it, the strip under it has Home, Rotate, light or
dark, Text Size, Screenshot, **More**, an iPhone Duo's **Posture** (Closed, Book, Open, Laptop), and the 3D or flat
switch.

To open a screen of your own, tap **New Screen** on the bot's page. **End Screen** closes it.

## Artifacts {#artifacts}

Reports shared in a chat show as a card; tap it to read. **Artifacts** on the bot's page lists them all, with the
files sent in the chat. HTML reports open on an iPhone only for now.

## Share into a chat {#share}

On an iPhone, **fleetd** is in every app's share sheet:

1. Tap **Share**, then **fleetd**.
2. Add a message if you like, and pick a chat.
3. Tap **Send**.

It sends text, a link, or up to 20 images. The lead is told it came from the share sheet, so it reads it as content,
not instructions.

## Shortcuts and the Action Button {#shortcuts}

On iOS 18 or later, fleetd's actions are in the Shortcuts app, Spotlight and Siri:

- **Open Chat**, **Send Message** (optionally waits for the reply), **Run Automation**, **Open Approvals**.
- **Get Latest Messages** and **Get Waiting Approvals**, which return what they read.

None of them approves, denies or pays. To put one on the Action Button, open **Settings › Action Button**, choose
**Shortcut**, then pick a fleetd action.

To let only some chats notify during a Focus: **Settings › Focus**, pick a Focus, then **Add Filter › fleetd**.

## Notifications {#notifications}

The app asks to send notifications when it first connects. They show the full text, end-to-end encrypted: only your
phone can read them.

Hold a notification to act on it: **Approve** or **Deny**, or **Reply**. Tapping one opens its chat.
See [Phone notifications](/docs/phone-notifications).

## Settings {#settings}

Tap your picture at the top of Chats:

- Your photo and name.
- **Connections**, **Devices**, **Vault**, **Memory** (with **Import Memory**) and **Notifications**.

Admins also get **Usage** (the desktop's [Usage page](/docs/desktop-app#usage), read-only), **Machines**, **Providers**
(the workspace's Anthropic key, Google sign-in per machine, and each provider's profiles), **Update** (updates the
workspace and every machine), **Restart Workspace**, and **Billing** on a cloud workspace.

### Devices {#devices}

**Settings › Devices** lists every device signed in as you. Tap one you don't know to sign it out: its key stops
working at once.

## Build it yourself {#build}

fleetd isn't in the App Store or Google Play yet. Build it on GitHub's runners from a fork:

1. Fork [unlaboredlabs/fleetd](https://github.com/unlaboredlabs/fleetd) and turn on Actions.
2. Android: run **CI** and download `fleetd-android-apk`. Open it on the phone.
3. iOS simulator: run **Nightly** with **only** set to `ios`, and download `fleetd-ios-simulator`.

A real iPhone needs a signed build.

### Signed builds {#signing}

Run **Mobile release**. Each platform is signed only once its secrets are set in your fork (Settings › Secrets and
variables › Actions).

#### Android {#android}

Make a keystore once, and keep it: every update must be signed with the same key.

```sh
keytool -genkeypair -v -keystore release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias fleetd
```

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 < release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore's password |
| `ANDROID_KEY_ALIAS` | The key's alias |
| `ANDROID_KEY_PASSWORD` | The key's password |

For notifications, set the variable `GOOGLE_SERVICES_JSON` to your Firebase project's `google-services.json`.

#### iOS {#ios}

You need a paid Apple Developer account, with app ids for your bundle id, `<id>.notifications` and `<id>.share`,
and an App Store profile for each.

Add these secrets, and one variable, `FLEETD_APP_ID`:

- Your Apple Distribution certificate and its password: `IOS_CERT_P12_BASE64`, `IOS_CERT_PASSWORD`
- The app's provisioning profile: `IOS_PROFILE_BASE64`
- The `.notifications` profile: `IOS_EXTENSION_PROFILE_BASE64`
- The `.share` profile: `IOS_SHARE_PROFILE_BASE64`
- Your team id: `APPLE_TEAM_ID`
- An App Store Connect API key, for TestFlight: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64`
- Your bundle id, such as `com.example.fleetd`: `FLEETD_APP_ID`

Tick **Send the iOS build to TestFlight** to upload it. With the key set, **Mobile release** also runs by itself after
each merge to `main` whose CI passed, builds that commit, and uploads a new build when the phone app changed since the
last one that went to TestFlight. A build you sign yourself needs
[its own notification relay](/docs/phone-notifications#own).

## Over-the-air updates {#updates}

A build signed with an update certificate gets new screens and fixes without a reinstall. It checks at launch and
uses the new version from its next start. Native changes still need a new build.

Pick the channel when you run **Mobile release**: `edge` gets each build's bundle once that build has reached every
workspace (see [Builds & rollout](/docs/releases#rings)), `stable` each tagged release. A fork that wants its own updates makes its own key with
`npm exec -- expo-updates codesigning:generate` in `app/mobile`, sets `UPDATES_PRIVATE_KEY_PEM`, `UPDATES_CERT_PEM` and
`FLEETD_UPDATES_URL`, and serves its own `site/`.
