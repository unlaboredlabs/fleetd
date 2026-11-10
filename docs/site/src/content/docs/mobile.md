---
title: Phone app
description: Chat with your projects and answer approvals from your phone. Build and sign it yourself, for iPhone and Android phones, on GitHub's runners, and update it over the air.
---

The phone app connects to your [hub](/docs/glossary#hub) as the desktop app does, with its own key. It shows your
[projects](/docs/projects), with what needs you on top, and their chats, live as the lead writes. A chat with an
[approval](/docs/approvals-and-secrets) waiting on you sits at the top of the list with its count, and **Needs you**
shows only those; you answer each from its card in the chat, with everything it would do. While the lead works, the
send button is **Stop**, which stops its running step and the project's agents, as on the desktop (a key that may
not stop it, such as a Read member's, has no Stop). What you were writing in a chat (its words, picked files and the
reply quote) stays there as you go between chats and when the app starts again; a file still uploading when the app
closes is left out. Notifications show the full text,
end-to-end encrypted. You can [watch and take over](#screens) a lead's or agent's screen when it needs
you (a captcha, a bank's check, a sign-in only you can do), open a screen of your own, read a chat's
[artifacts](#artifacts), make, rename, archive and delete projects, and on an iPhone
[share](#share) text, links and images into a chat from any app. An admin can update fleetd and restart the hub. Secrets, machines, people
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
saying so. Give the hub its tailnet or LAN address: on the hub, run
`fleetd init --listen <ip>:<port> --url http://<name>:<port>` (Settings › Hub › Setup › Where the hub listens), then
pair again. A phone paired from the desktop app is yours and gets your device's role. A
phone paired with `fleetd pair` gets that code's `--role`.

The key stays in the phone's secure storage (the Keychain on iOS, the Keystore on Android). Settings, behind your
avatar at the top of Chats, shows you, the hub, its address and version, and this phone. Tap your picture at its top
to choose a photo of yourself from Photos, moved and scaled in a circle, or remove it: it shows in place of your initial
at the top of Chats, on every phone of yours (`person_avatar_set`; the hub keeps a small JPEG of the circle, without
the photo's metadata, and `person_avatar_get` reads it). Tap your name beside it to change it: **Done**, tapping
away or going back saves it for everyone on the hub (`person_name_set`). **Disconnect**, at its end, asks
first, then signs the phone out on the hub, which revokes its key and stops its notifications, and forgets the hub. If
the hub can't be reached, you can forget it anyway and sign the phone out later: **Sign out** on its row under
Settings › You › Your devices in the desktop app.

Hubs on a tailnet often answer plain HTTP. The app allows that on both platforms, so turn Tailscale on in the phone
and use the hub's tailnet name or address: `devbox`, `devbox.<tailnet>.ts.net` or its `100.x` address. A hub at any
other address works over plain HTTP too.

## Pinned chats {#pins}

Swipe a chat right and tap the orange pin, or hold it and pick **Pin**. Pinned chats sit above the list as large round
avatars, three to a row, up to nine. An unread chat's newest message shows in a bubble over its avatar, with a dot by
its name. While its lead works, a typing bubble shows instead. An approval waiting shows as an orange count. Tap an
avatar to open the chat, or hold it to mark it read or unread, unpin it, mute it or move it to a
[section](#sections). A filter or a search shows pinned chats as plain rows.

Your pins are yours: the hub keeps them, in order, for each person, so they're the same on each of your phones. A
teammate's pins never change your list. Each hub keeps its own, and the app keeps them apart. The first time it connects
to a hub that keeps pins, it sends up the pins it already had of that hub's chats, never another hub's.

## Sections {#sections}

Sections group your chats under names of your own. Hold a chat, or a pinned avatar, and pick **Move to Section…**: the
sheet lists your sections with a ✓ on the chat's own, **No Section**, and **New Section…**, which asks for a name. A
section is made with its first chat and goes away with its last.

Under the pins, the chats in no section come first, with no label. Then each section sits under its quiet label, its
chats ordered as the rest of the list is. Tap a label to fold the section to one line: its name, how many chats it
holds, and a dot when one of them needs you or is unread. Tap again to open it. Which sections are folded is kept on
this phone. Hold a label for **Rename…**, **Move Up**, **Move Down** and **Remove Section**, which puts its chats back
on top and deletes none of them. A pinned chat shows among the pins only, and keeps its section for when you unpin it. A
filter or a search is a flat list with no labels.

Your sections are yours: the hub keeps them, in your order, for each person, so they're the same in the desktop app and
on each of your phones. A teammate's sections never change your list, and each hub keeps its own. A name is up to 40
characters, no two sections share one, and you can have up to 50. A project that's deleted leaves its section by itself;
an archived one keeps its place. A change shows at once and is sent when the hub is next reachable. If the hub refuses
it, the list goes back and a line over it says why.

## Projects {#manage}

Tap **+** at the top of Chats for **New Project**: a name, and optionally a GitHub repo to clone (`owner/repo` or its
URL) or the path of a folder already on a machine; with neither, the machine makes a new folder for it. Then the
machine, and **Only Me**, on for a project with no repo until you turn it off ([Only me](/docs/projects#only-me)). A
new folder's chat opens at once. Under the field, the app lists the checkouts it found on your machines and your
  GitHub repos, filtered as you type; one that's already a project opens its chat. A clone shows its progress, then
  what the hub read of the repo: its default branch, CI and merge rules. When the clone's folder already holds the
  same repo, **Add the Folder That's There** adds it as it is.

The **ⓘ** at the top of a chat opens its project's page:

- **Its icon**: tap the avatar, or **Edit** under it. Pick one of nine glass faces and one of twelve colors; the
  icon at the top shows it at once, and **Done** keeps it. Or **Choose Photo** or **Take Photo** (and, once it has
  one, **Remove Photo**): a photo opens in **Move and Scale**, pinch to zoom, drag to move, then **Choose**. Every
  phone and desktop shows it. A project nobody picked for wears one made from its id. The hub keeps only a
  photo's circle, at most 512 px, without its location or other metadata.
- **Agents**: the lead and the agents working now, each with its state. Then the project's open orders, its
  **To-do** and its merges of the last two weeks, each opening its pull request. Change these in the chat or the
  desktop app.
- **Name**: rename it. Its folder keeps its name.
- **Agent profiles**, when the hub has more than one: the profiles its lead may run agents on. The hub's default is
  always allowed.
- **Only Me**: who sees and uses it, as in the desktop app.
- **Machine** and **Folder**: where it runs, read only.
- **Approvals**, **Payments**, **Linked Hubs** and **Skills**: the project's
  [approval mode](/docs/projects#approvals) and what ran without asking, its card and purchases, the hubs it reaches
  and what it learned, as in the desktop app's settings.
- **Artifacts**: the chat's [artifacts](#artifacts). The checker's model and linking a hub are done
  in the desktop app.
- **Forget Sign-ins…**: signs it out of every site its browser kept, after a confirm.
- **Archive Project** sets it aside with everything kept, under the **Archived** filter in Chats (it shows in the list
  again while an approval of its waits); **Unarchive Project** brings it back.
- **Delete Project**: erases everything fleetd keeps for it, as in the desktop app ([Delete a
  project](/docs/projects#delete)), with a tickbox for its folder, once you type its name. When worktrees hold
  uncommitted changes, which the delete loses, the confirm names them. Delete waits until the machine can list them.

A member does everything here on the machines they operate, and what you may not do isn't offered. An
[Only me](/docs/projects#only-me) project is its owner's alone. The hub checks each change too.

## Screens {#screens}

A lead or agent that needs you on its [screen](/docs/browser-sessions) (a captcha, a bank's 3-D Secure check, a passkey,
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
operate on its machine, and an [Only me](/docs/projects#only-me) project's screen is its owner's alone: nobody else can
watch it, take it over or read its recording. What you type goes to the page; the action log says that you took over,
never what you typed.

**New Screen**, on a project's ⓘ page, opens a screen of your own: a browser unless you pick another kind, and the
machine when more than one can. A kind no machine can host says why in its row; picked, it says why in full under
**Can't open**, with **Turn On** for an owner or admin where it is only switched off on a machine, or whom to ask. It
opens in the live view with you in control, and **End Screen** closes it. A browser starts on a blank page: tap the bar
at the top to say where it goes. It runs on the project's own machine, on the profile the project keeps, so a site you
sign in to there stays signed in for its lead. On a full machine, **Wait** keeps your place for its next slot, and the
screen opens once it has one. A PR's build opens from the desktop app. See
[Open one yourself](/docs/browser-sessions#yours).

## Artifacts {#artifacts}

The reports a lead or its agents [publish](/docs/chat#artifacts) in a chat show there as a card; tapping it, or a link
to it in a message, opens it. **Artifacts**, on the project's ⓘ page, lists them newest first, each with its format,
who published it, when and its version, then the files sent in the chat (tapping one opens the share sheet). A
Markdown artifact reads as the chat's own formatted text. An HTML one runs on an iPhone fenced as on the desktop: its
scripts on, nothing loaded past the page itself, no storage, cookies or files; a link in it opens in your browser.
Android doesn't run HTML artifacts yet and says to open them on an iPhone or the desktop app. With more than one
version, **Versions** picks an older one, which says so over the page with the way back to the newest.

## Update fleetd {#update}

An admin sees **Update** in Settings when the hub has a newer fleetd ready, or a machine runs an older one than the
hub. It does what the desktop app's Update does: the hub updates itself, then every machine, and the app follows it
live, machine by machine, to the outcome. A machine that failed or was put back gets **Retry**. Members don't see it,
and the hub refuses them anyway.

Above it, an admin has **Restart Hub**, the desktop app's [Restart hub](/docs/several-hubs#restart): it asks first, the
hub is back in about a second while agents carry on, and each lead whose profile changed since it started comes back
on the current one. Members don't see it either.

## Import memory {#import-memory}

**Settings › Import Memory** brings what another assistant knows about you into your own memory, as the desktop app's
Settings › Your memory › Import memory does.

1. Tap **Copy Prompt** and paste it into a chat with ChatGPT, Claude, Grok or another assistant.
2. Paste its answer into the box and tap **Add to Memory**.

The hub picks out what's worth remembering, on your own Claude account, which takes about a minute. Then the screen says
how many entries it added, and whether it left out lines that looked like keys or passwords, or entries that didn't fit
because your memory is full.

## Share to fleetd {#share}

On an iPhone, **fleetd** is in the share sheet of Safari, Photos and any other app. It sends text, a link or up to 20
images into a chat you pick, with a message of your own if you want one.

1. Tap **Share**, then **fleetd**. The sheet shows what you're sharing, with **Add a message** under it.
2. Pick a chat: your most recent ones are in a row on top, then every project, with **Search chats**.
3. Tap **Send**. Images go up first, then the message with them, and the sheet closes once the hub has it.

A link goes as its page title and address, after your message. Images the hub doesn't take as they are, such as HEIC
photos, go as JPEG. Each file can be up to 25 MB, the hub's limit. Shared text longer than a message (100,000
characters) goes as a text file. If the connection drops while sending, **Retry** sends the same message: never a second
copy.

The share sheet uses the app's own pairing. It reads the hub's address and the phone's key from the Keychain group the
app shares with its extensions, and keeps no copy. If the phone isn't paired, or the hub refuses its key, the sheet
says so and offers **Open fleetd**. If the hub can't be reached, it offers **Try Again** as well. Android doesn't have
it yet.

A message sent from the share sheet shows **via the Share Sheet** in the chat, on the phone and the desktop, and the
lead is told it came that way: what another app shared is content to read, not your instructions.

## Shortcuts and the Action Button {#shortcuts}

On an iPhone with iOS 18 or later, fleetd's actions are in the Shortcuts app, Spotlight and Siri with no setup, and any
of them can go on the Action Button. They sign in to your hub as the app does, with the phone's own pairing.

| Action | What it does | Returns |
| --- | --- | --- |
| **Open Chat** | Opens a project's chat. | |
| **Send Message** | Sends text, files or both to a chat as you, without opening the app. Optionally waits for the reply. | The reply's text, with **Wait for Reply** on |
| **Run Automation** | Runs one of your [automations](/docs/automations) now, as **Run now** does. | |
| **Open Approvals** | Opens Chats on **Needs You**. | |
| **Get Latest Messages** | Reads a chat's newest messages: a count, or the ones since a date. | Each message's author, text and date |
| **Get Waiting Approvals** | Reads what is waiting on you. | How many, and each with its chat |

None of them approves, denies, enters a secret or pays: those stay in the app. **Wait for Reply** is off by default;
with it on, the action waits up to **Wait Up To** seconds (20, the most) for the lead's turn to end, then returns
everything it said. iOS ends an action that runs past about half a minute, so it suits quick answers. If no reply comes
in time, the action fails with **No reply yet**: the message is still sent, and the reply shows in the chat. For a
longer job, send without waiting and read the answer later with **Get Latest Messages**.

**Files** on Send Message take what an earlier action hands it: a photo, a PDF, a scanned document, a text file. The
hub takes images, PDFs, text and CSV files, Word, Excel and PowerPoint documents and zip archives, up to 25 MB each and
20 in one message. Photos of another type, such as HEIC, go as JPEG; any other file makes the action fail with
**fleetd doesn't take** and its name, before anything is sent.

A message from **Send Message** shows **via Shortcuts** under it, on the phone and the desktop, and the lead is told it
came from Shortcuts: it may hold content the shortcut pulled from elsewhere, such as a web page or the
clipboard, which it reads as content, not as your instructions. Approvals and notifications work as for a message you
typed.

**Put one on the Action Button:** open **Settings › Action Button**, swipe to **Shortcut**, tap **Choose a Shortcut**,
then under **fleetd** pick an action. **Open Chat** lists each of your chats as its own shortcut ("Open Errands"), so the
button opens that chat directly.

**Only some chats notify during a Focus:** open **Settings › Focus**, pick a Focus, then under **Focus Filters** tap
**Add Filter › fleetd** and choose the chats. While that Focus is on, only those chats' notifications come through; an
urgent one (money, irreversible commands) always does. A filter with no chats picked lets every chat notify.

If an action can't run, it says why:

- **Unlock your iPhone:** the phone's key to the hub opens once the phone has been unlocked since it started. After
  that, automations run while it's locked too; only one that runs after a restart, before the first unlock, fails.
- **Pair fleetd first:** the phone isn't paired. Open the app and pair it.
- **Your hub refused this phone:** its key was revoked or the hub was set up again. Pair it again.
- **Can't reach your hub:** the hub is down, or the phone can't reach it (on a tailnet, Tailscale is off).
- **That chat isn't on your hub any more:** it was archived or deleted. Edit the shortcut and pick another.

### Automation ideas {#automation-ideas}

In the Shortcuts app's **Automation** tab, or on the Action Button:

- **Arrive home → Send Message:** "I'm home" to an Only me project, which can turn the lights on or post your evening
  plan.
- **Action Button → Take Screenshot, then Send Message with it as Files:** what's on screen goes to a project with
  "What's wrong here?".
- **Work Focus → Focus filter:** only your projects notify while you work.
- **NFC tag → Run Automation:** tap a tag on your desk to start your morning brief.
- **CarPlay connects → Get Latest Messages, then Speak Text:** hear a project's last replies on the drive.
- **Time of day, 9:00 → Get Waiting Approvals, then If Count is greater than 0, Show Notification:** a morning nudge
  when something waits on you.

Android doesn't have them yet.

## Notifications {#notifications}

The first time the app connects, it asks to send notifications. They show what happened in full: a lead's reply, an
approval waiting for you, an order that landed or stopped.

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
