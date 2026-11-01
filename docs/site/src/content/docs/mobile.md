---
title: Phone app
description: Chat with your Navis and projects and answer approvals from your phone. Build and sign it yourself, for iPhone and Android phones, on GitHub's runners, and update it over the air.
---

The phone app connects to your [hub](/docs/glossary#hub) as the desktop app does, with its own key. It shows your
[Navis](/docs/navi) and projects, with what needs you on top, and their chats, live as the lead writes. A chat with an
[approval](/docs/approvals-and-secrets) waiting on you sits at the top of the list with its count, and **Needs you**
shows only those; you answer each from its card in the chat, with everything it would do. Its notifications show the
full text, end-to-end encrypted. You can [watch and take over](#screens) a Navi's or agent's screen when it needs
you (a captcha, a bank's check, a sign-in only you can do), open a screen of your own, make, rename and delete Navis
and projects, and on an iPhone
[share](#share) text, links and images into a chat from any app. An admin can update fleetd. Secrets, machines, people
and the hub's other admin pages stay in the desktop app.

fleetd doesn't publish the app in Apple's or Google's stores yet. You build it from the repository on GitHub's
runners: no Expo account and no EAS.

## Pair it {#pair}

1. In the desktop app, open **Settings › Your devices** and click **Pair a phone**. Or run `fleetd pair` on the hub,
   which prints the QR code in the terminal above the code (`--no-qr` leaves it out). Either shows a QR code, and the
   hub's address and a one-time code under it.
2. In the app, tap **Scan QR Code** and point the camera at it: the phone pairs at once, and Your devices in the
   desktop app shows it as soon as it has. The iPhone's Camera app works too: scanning the code opens fleetd, which
   asks **Connect to** the hub first.

Without a camera, tap **Enter Code Manually**, enter the hub's address, such as `http://devbox:4790`, and the code (or
tap **Paste** with the code or the QR code's link copied), and tap **Connect**. A code works once, for 15 minutes, and
the QR code lasts no longer.

The QR code holds a link, `fleetd://pair?hub=<the hub's address>&code=<the code>`. Opened any other way than the app's
own scanner (the Camera app, a page, a message), it names the hub and asks before pairing, as anyone can send one.
The address is one a phone can reach: the one the desktop app reaches the hub at, else the hub's own tailnet or LAN
address, never `127.0.0.1` or `localhost`. When the hub has only a loopback address, you get no QR code and a note
saying so. Run `fleetd init` again on the hub and pick its tailnet or LAN address (Settings › Hub › Setup › Where the
hub listens says how), then pair again. A phone paired from the desktop app is yours and gets your device's role. A
phone paired with `fleetd pair` gets that code's `--role`.

The key stays in the phone's secure storage (the Keychain on iOS, the Keystore on Android). **Disconnect**, in the
app's Settings tab, asks first,
then signs the phone out on the hub, which revokes its key and stops its notifications, and forgets the hub. If the hub
can't be reached, you can forget it anyway and sign the phone out later under Settings › You in the desktop app.

Hubs on a tailnet often answer plain HTTP. The app allows that on both platforms, so turn Tailscale on in the phone
and use the hub's tailnet name or address: `devbox`, `devbox.<tailnet>.ts.net` or its `100.x` address. A hub at any
other address works over plain HTTP too.

## Pinned chats {#pins}

Swipe a chat right and tap the orange pin, or hold it and pick **Pin**. Pinned chats sit above the list as large round
avatars, three to a row, up to nine. An unread chat's newest message shows in a bubble over its avatar, with a dot by
its name. While its lead works, a typing bubble shows instead. An approval waiting shows as an orange count. Tap an
avatar to open the chat, or hold it to mark it read or unread, unpin it or mute it. A filter or a search shows pinned
chats as plain rows.

Your pins are yours: the hub keeps them, in order, for each person, so they're the same on each of your phones. A
teammate's pins never change your list. Each hub keeps its own, and the app keeps them apart. The first time it connects
to a hub that keeps pins, it sends up the pins it already had of that hub's chats, never another hub's.

## Navis and projects {#manage}

Tap **+** at the top of Chats for **New Navi** or **New Project**.

- **New Navi**: a name (Navi when left empty) and, with more than one machine it could live on, which one. Its chat
  opens once it's made.
- **New Project**: a GitHub repo to clone (`owner/repo` or its URL) or the path of a folder already on a machine, an
  optional name, and the machine. Under the field, the app lists the checkouts it found on your machines and your
  GitHub repos, filtered as you type; one that's already a project opens its chat. A clone shows its progress, then
  what the hub read of the repo: its default branch, CI and merge rules. When the clone's folder already holds the
  same repo, **Add the Folder That's There** adds it as it is.

The **ⓘ** at the top of a chat opens its Navi's or project's page:

- **Its icon**: tap the avatar, or **Edit** under it. Pick one of nine glass faces and one of twelve colors; the
  icon at the top shows it at once, and **Done** keeps it. Or **Choose Photo** or **Take Photo** (and, once it has
  one, **Remove Photo**): a photo opens in **Move and Scale**, pinch to zoom, drag to move, then **Choose**. Every
  phone and desktop shows it. A project or Navi nobody picked for wears one made from its id. The hub keeps only a
  photo's circle, at most 512 px, without its location or other metadata.
- **Running**: the lead and the agents working now, each with its state. Then the project's open orders, its
  checklist and its merges of the last two weeks, each opening its pull request. Change these in the chat or the
  desktop app.
- **Name**: rename it. Its folder keeps its name.
- **Agent profiles**, for a project, when the hub has more than one: the profiles its lead may run agents on. The
  hub's default is always allowed.
- **Forget Sign-ins…**, for a Navi: signs it out of every site its browser kept, after a confirm.
- **Delete Navi** or **Delete Project**: asks first and names what goes. Its agents stop and fleetd forgets it, with
  its fleetd worktrees and the checkouts of the project's other repos. Its folder, branches and pull requests stay.
  When worktrees hold uncommitted changes, which the delete loses, the confirm names them and you type the project's
  name to delete, as in the desktop app. Delete waits until the machine can list them.

A member does everything here on the machines they operate. A Navi is its owner's alone: only they can rename it,
forget its sign-ins or delete it. The hub checks each change too.

## Screens {#screens}

A Navi or agent that needs you on its [screen](/docs/browser-sessions) (a captcha, a bank's 3-D Secure check, a passkey,
a sign-in only you can do) asks for you with `request_takeover`. The phone gets a notification, "Needs you on its
screen: Solve the captcha on booking.com", and the chat shows a card, **Nova needs you**, with its reason and **Open**.
Any other screen running in the chat has a card too, with **Watch**.

Either opens the screen's live view, full screen: the page as its agent sees it, with who has control under its
site's name.

- **Pinch** to zoom, and move the zoomed page with two fingers.
- **Take Over** gives you the page once its machine confirms it. Then a **tap** clicks, a **drag** scrolls the page,
  and a touch **held** a moment presses and drags (a slider, a press-and-hold check). The keyboard button types into
  the page, Return included.
- A browser that's yours has an address bar: tap its site at the top and type an address (`booking.com` goes to
  `https://booking.com`) or words to search for. Reload is beside it, and back and forward are by the keyboard button.
- **Hand Back** gives it back to its agent, which sees the page as you left it. Closing the view while you have
  control asks whether to hand it back first; **Keep Control** leaves it yours, and its card opens it again.

It's the desktop's live view and takeover, over the same hub connection: the phone draws at most 12 frames a second,
and a slow connection skips frames rather than falling behind. Only a person's device takes a screen over, with
operate on its machine, and a Navi's screen is its owner's alone: nobody else can watch it, take it over or read its
recording. What you type goes to the page; the action log says that you took over, never what you typed.

**New Screen**, on a project's or Navi's ⓘ page, opens a screen of your own: a browser unless you pick another kind,
and the machine when more than one can. A kind no machine can host says why in its row; picked, it says why in full
under **Can't open**, with **Turn On** for an owner or admin where it is only switched off on a machine, or whom to
ask. It opens in the live view with you in
control, and **End Screen** closes it. A browser starts on a blank page: tap the bar at the top to say where it goes. A Navi's browser runs on the Navi's own profile, so a site you sign in to there
stays signed in for it. On a full machine, **Wait** keeps your place for its next slot, and the screen opens once it
has one. A PR's build opens from the desktop app. See [Open one yourself](/docs/browser-sessions#yours).

## Update fleetd {#update}

An admin sees **Update** in Settings when the hub has a newer fleetd ready, or a machine runs an older one than the
hub. It does what the desktop app's Update does: the hub updates itself, then every machine, and the app follows it
live, machine by machine, to the outcome. A machine that failed or was put back gets **Retry**. Members don't see it,
and the hub refuses them anyway.

## Import memory {#import-memory}

**Settings › Import Memory** brings what another assistant knows about you into your own memory, as the desktop app's
Settings › Memory does.

1. Tap **Copy Prompt** and paste it into a chat with ChatGPT, Claude, Grok or another assistant.
2. Paste its answer into the box and tap **Add to Memory**.

The hub picks out what's worth remembering, on your own Claude account, which takes about a minute. Then the screen says
how many entries it added, and whether it left out lines that looked like keys or passwords, or entries that didn't fit
because your memory is full.

## Share to fleetd {#share}

On an iPhone, **fleetd** is in the share sheet of Safari, Photos and any other app. It sends text, a link or up to 20
images into a chat you pick, with a message of your own if you want one.

1. Tap **Share**, then **fleetd**. The sheet shows what you're sharing, with **Add a message** under it.
2. Pick a chat: your most recent ones are in a row on top, then every Navi and project, with **Search chats**.
3. Tap **Send**. Images go up first, then the message with them, and the sheet closes once the hub has it.

A link goes as its page title and address, after your message. Images the hub doesn't take as they are, such as HEIC
photos, go as JPEG. Each file can be up to 25 MB, the hub's limit. Shared text longer than a message (100,000
characters) goes as a text file. If the connection drops while sending, **Retry** sends the same message: never a second
copy.

The share sheet uses the app's own pairing. It reads the hub's address and the phone's key from the Keychain group the
app shares with its extensions, and keeps no copy. If the phone isn't paired, or the hub refuses its key, the sheet
says so and offers **Open fleetd**. If the hub can't be reached, it offers **Try Again** as well. Android doesn't have
it yet.

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
- Tapping one opens its chat; an approval's opens at its card, and a screen's that needs you opens its live view.
- Press and hold one to act on it without opening the app: Approve or Deny an approval, Reply to a message. The app
  icon's badge counts what needs you. See [Act from a notification](/docs/phone-notifications#actions).

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

To try changes on a simulator without a build each time, run the workflow with **metro** set to a Metro server the
simulator reaches, such as `100.64.0.5:8093`, and run `npm exec -- expo start --port 8093` in `app/mobile` there. That run
builds a Debug app that loads its JavaScript from that server.

The workflow runs `expo prebuild`, then gradle on an Ubuntu runner and xcodebuild on a macOS runner. On pull requests
and on `main`, the app's checks and the Android build run when `app/mobile`, the workflow, or a desktop module the app
imports (`app/mobile/src/desktop.ts` lists them) changes. The iOS build runs on a manual run, and nightly and before
each release in the **Mac** workflow (`mac.yml`), never on a pull request: the Android build bundles the same
JavaScript, so a change that breaks it fails there.

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

You need a paid Apple Developer account and three app ids:

- one for the bundle id you pick, with the Push Notifications and Time Sensitive Notifications capabilities
- one for its notification extension, the same id plus `.notifications`
- one for its share extension, the same id plus `.share`

The extensions' app ids need no capabilities. Make an App Store distribution provisioning profile for each id, with
your Apple Distribution certificate.

| Secret | Value |
|---|---|
| `IOS_CERT_P12_BASE64` | `base64 < dist.p12` of an Apple Distribution certificate with its private key |
| `IOS_CERT_PASSWORD` | The `.p12`'s export password |
| `IOS_PROFILE_BASE64` | `base64 < fleetd.mobileprovision` of a distribution provisioning profile for the bundle id |
| `IOS_EXTENSION_PROFILE_BASE64` | The same, for the notification extension's id (`<bundle id>.notifications`) |
| `IOS_SHARE_PROFILE_BASE64` | The same, for the share extension's id (`<bundle id>.share`) |
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
build number, which every upload must raise. If only some of the iOS secrets are set, the run skips iOS and its
**signing** job names the missing ones.

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

- Secrets, settings, a screen's recording, and a PR's build in a screen: use the desktop app.
