# Phone notifications, end-to-end encrypted

D218. Phone notifications show the full text, like a chat app's, and only the phone can read them. The phone makes an
X25519 key pair when it pairs and registers its push token and public key with the hub. The hub seals each
notification to that key and posts the ciphertext to a push relay. The relay is `fleetd push-relay`: open source,
run by whoever holds the app's Apple and Firebase credentials. It forwards the ciphertext to APNs or FCM without
reading it. For the published app (sh.fleetd.app) that relay is `https://push.fleetd.sh`, and every hub sends there
until told otherwise (D225). On the phone, the iOS Notification Service Extension or the Android message handler opens it and shows
it.

```text
hub ── seal(payload, device key) ──▶ relay ── APNs alert / FCM data ──▶ phone: open, show
```

This note is the contract between the hub (`crates/fleetd/src/hub/push`), the relay
(`crates/fleetd/src/push_relay`) and the mobile app (`app/mobile`). The types live in
`crates/fleetd-contracts/src/push.rs`.

## Registering a phone

Hub tools, called with the phone's own human key. A phone is its person's only: an agent key, or a key with no
person, is refused.

| Tool | Input | Output |
|---|---|---|
| `push_device_register` | `{platform: "ios"\|"android", token, publicKey, name}` | `{device, relay}` |
| `push_devices_list` | `{}` | `{devices, relay}` |
| `push_device_remove` | `{deviceId}` | `{device}` |
| `push_badge` | `{}` | `{badge}` |
| `push_relay_set` | `{url, key?}` (empty URL: off) | `{url?, key, default}` |

- `token`: the APNs device token as hex, or the FCM registration token.
- `publicKey`: the phone's 32-byte X25519 public key in standard base64.
- `device`: `{deviceId: "pd_…", platform, name, createdAt, lastSentAt?}`. The token and key are never returned.
- `relay`: whether the hub sends notifications: true with the default relay, false once an admin turned them off.
- Registering the same token again updates that device (a new key or name) and moves it to the caller's person. The
  app registers again whenever the OS gives it a new token, and removes the device when the person signs out.
- `badge`: the number each notification carries in its own `badge` (below). The app reads it after acting from a
  notification and as it goes to the background, so the icon clears as the person acts.
- At most 20 devices per person.
- `push_relay_set` needs Admin on every machine: an owner or admin, or `fleetd push-relay set` on the hub. `key` is
  the relay's key sealed (`crypto_box_seal`) to the hub's `boxPubKey` from `hub_links_get`; the hub keeps it sealed
  to itself and sends it as `Authorization: Bearer`. The call replaces the whole setting: a URL without `key` drops
  the key. The output's `key` says whether one is kept, `default` whether the default relay applies.

## The relay setting

One row in `push_relay`, three states:

| Row | The hub sends to |
|---|---|
| none (never set) | `https://push.fleetd.sh` (`DEFAULT_RELAY` in `hub/push/mod.rs`), with no key |
| `url = ''` (`set off`) | nobody. Kept in the database, so it outlasts a restart |
| a URL, maybe a sealed key | that relay, with that key |

`set https://push.fleetd.sh` without a key deletes the row, so the hub follows the default again. Whatever is set,
the hub sends push.fleetd.sh no key and reaches it over https only: `push_relay_set` refuses `http://` or a key for
that host, and a row that says otherwise sends nothing and logs why. A hub that ran `set off` before D225 has no row
and now uses the default; run `set off` again. There is no per-hub binding of a phone to its hub (Nextcloud's push
proxy has one): only if the public relay is ever abused.

A device whose key is revoked (signed out under Settings › You), or whose person was removed, gets nothing.

## Keys and sealing

- The phone makes the key pair with libsodium's `crypto_box_keypair` when it pairs with a hub. The secret key stays
  on the phone: on iOS in the Keychain, in an access group the Notification Service Extension shares; on Android in
  storage encrypted with a Keystore key.
- The hub seals with `crypto_box_seal`: an ephemeral X25519 key, XSalsa20-Poly1305, and the nonce from
  BLAKE2b(ephemeral key ‖ device key). The phone opens it with `crypto_box_seal_open`. The sealed box is the
  plaintext plus 48 bytes, sent as standard base64.
- A key pair is one hub's. The phone pairs with one hub at a time, makes a new pair at each pairing and deletes it
  at Disconnect (`pairWith` and `forgetPush` in `src/vault.ts`), so no hub it was paired with before can seal a
  notification that opens there and claims to come from another. The payload's `hub` says which hub sent it.

## The payload

The plaintext is UTF-8 JSON of at most 2400 bytes, so the sealed, base64 ciphertext stays under the 4 KB limit of
APNs and FCM. The hub cuts `body` to fit.

```json
{
  "v": 1,
  "kind": "message",
  "title": "Ada",
  "body": "Your flight moved to 9:40.",
  "hub": "http://devbox:4790",
  "machineId": "devbox",
  "projectId": "navi-ada",
  "messageId": "m42",
  "at": "2026-10-29T08:12:00.000Z"
}
```

| Field | |
|---|---|
| `v` | 1. A phone shows its generic text for a version it doesn't know. Version 1 only gains optional fields: a phone ignores one it doesn't know, so an older app shows the same notification without its buttons or badge. `v` changes only for a payload an older app would show wrongly. |
| `kind` | `message` (a Navi's or lead's chat message), `approval` (a request waiting for an answer), `order` (an order landed or stopped), `alert` (anything else marked for the person). An app shows an unknown kind as `alert`. |
| `title` | The Navi's or project's title, or "fleetd". |
| `body` | The message's text on one line, or the event's summary. |
| `hub` | The hub's URL. |
| `machineId`, `projectId` | The project it is about: tapping it opens that chat. Absent for an event about no project. |
| `threadId`, `messageId` | When the event names them. |
| `requestId` | `approval`: the request (`Q…`) to answer with `approval_answer`. |
| `urgent` | `true` for money or irreversible commands: show it even in a Focus (iOS `time-sensitive`). |
| `quiet` | `true` inside the hub's quiet hours (`policy.quiet_hours`): show it without a sound. |
| `category` | What the notification's buttons do: `approve` (Approve and Deny), `review` (open the approval's card), `reply` (a text reply into the chat). Absent: only open it. |
| `badge` | How many things need the person now: each open request, plus each chat waiting on them with none open, of the projects whose notifications are theirs. The app icon's badge. |
| `at` | When the event happened. |

## Acting from a notification

The hub picks each notification's `category`, inside the sealed payload, so the relay learns nothing new:

- **Approve and Deny** (`approve`): an approval whose body is everything its card shows, whole on one line: the
  lead's reason, then exactly what runs. That is a gated run's command and the directory it runs in, when it injects
  no secret and is neither money nor irreversible; or a tool prompt that is a one-line Bash command, its whole input.
  Everything else gets **Review** (`review`), which opens the full card in the app, as D183 and D193 ask: a run that
  injects a secret, money or irreversible commands, any other tool prompt (its summary is only a part of what runs:
  a Write's path, a script's first line, an MCP tool's description), an integration's send or change, a first visit
  to a site, a preview setting. A body cut to fit is no longer exact, so it gets Review too, and so does a command
  that could read differently on a lock screen than it runs (`shown_whole`): over 200 characters, or holding a control
  character (`\r`, tab, escape), a line or paragraph separator, a bidi control or mark, a zero-width character or
  another invisible format character (interlinear annotation, deprecated format, shorthand and musical format
  controls). The class is the one the apps' cards mark (`isHidden` in `app/desktop/src/shared/hidden.ts`), so hub,
  notification and cards agree; only the hub also refuses an emoji's joiner or selector and a joiner inside a
  Persian or Hindi word, which the cards show as written.
  The text shown beside it must hold none of those either (`plain`): the title, the lead's reason and the directory. A secret gets no button:
  it is entered in the app.
- **Reply** (`reply`): a Navi's or a lead's message. The text goes into that chat with `chat_send`.

The phone registers three categories (`CATEGORIES` in `src/push.ts`): `fleetd.approve`, `fleetd.review` and
`fleetd.reply`. It never trusts `approve` on an `urgent` payload: that shows Review whatever the hub said, in the
extension and in the app. Every button that calls the hub needs the phone unlocked (`authenticationRequired`): it
acts with the phone's own key, which the Keychain gives out only then. The app does the action on a connection of its
own, since iOS may have started it in the background just for the button. Then it shows the outcome in place of the
notification, without a sound ("Approved: …", "Not denied: Already answered…"), and sets the badge from
`push_badge`. A sent reply just disappears, as in Messages.

Notifications stack per chat: iOS's thread is `machineId/projectId`, and the categories' summary reads "3 more
messages" or "3 more approvals". Android keeps one notification per chat and one per request.

## What is pushed, and to whom

The hub doesn't make a second list of what matters. It pushes:

- a chat message from a Navi's or a project's lead, once it is final and has text;
- every event the hub already marks with `attention` (loud or urgent): an open request, a machine down under running
  work, a usage limit, a fetch that failed;
- `workstream.done`, and `workstream.state` to `stopped`: an order landed or failed.

Who gets it: a Navi's events go to its owner only. Another project's go to the person who last wrote in its chat,
else the hub's owner. An event about no project goes to the hub's owners and admins.

## Delivery

The relay gets one request per device:

```http
POST /v1/push
{"platform": "ios", "token": "…", "ciphertext": "…", "collapseKey": "3f2a…"}
```

`collapseKey` is optional and opaque (16 hex characters, a hash). An approval's notification uses one, so a later
push about the same request replaces it.

| Answer | Meaning |
|---|---|
| 200 `{"status": "sent"}` | APNs or FCM took it. |
| 200 `{"status": "dead"}` | APNs or FCM no longer knows the token. The hub drops the device. |
| 400 / 401 / 413 / 429 / 502 / 503 `{"status": "failed", "error"}` | Malformed, no or the wrong relay key, too big (ciphertext over 3500 characters, body over 8 KB), more than 60 pushes a minute to one token or 600 from one IP address, an upstream failure, or a platform the relay has no credentials for. |

`dead` is only an answer that means that token alone is gone: APNs 410 (Unregistered); APNs BadDeviceToken or
DeviceTokenNotForTopic once a push has gone through since the relay started (before that they are what every token
gets with the wrong `FLEETD_APNS_SANDBOX` or `FLEETD_APNS_TOPIC`); FCM UNREGISTERED. The relay's setup errors
(BadTopic, TopicDisallowed, InvalidProviderToken, FCM SENDER_ID_MISMATCH, 401, 403, a 404 without UNREGISTERED) are
`failed`, with what to fix in `error`. As a backstop, when one notification's answers would drop more than half of a
person's devices, or their only one, the hub keeps them all. It logs each distinct failure once an hour at most.

With `FLEETD_PUSH_RELAY_KEY_FILE` set, the relay refuses a request without `Authorization: Bearer <key>` (401).
push.fleetd.sh runs without one: anyone may post to it, so it counts pushes per source IP as well as per token. The
source is the TCP peer; when the peer is loopback (Caddy in front of the relay on the same machine) it is the last
`X-Forwarded-For` entry, the one the proxy added. A header from any other peer is ignored.

`GET /` answers `{"ok": true, "apns": bool, "fcm": bool}`.

**iOS.** The relay sends an APNs alert (`apns-push-type: alert`, priority 10) with token auth from the publisher's
.p8 key:

```json
{"aps": {"alert": {"title": "fleetd", "body": "New activity"}, "mutable-content": 1, "sound": "default"}, "c": "<ciphertext>"}
```

The Notification Service Extension opens `c` and sets the title and body. It sets `threadIdentifier` to
`machineId/projectId`, the category from `category` (as above), the badge from `badge`, drops the sound when `quiet`,
and sets the interruption level to time-sensitive when `urgent`. A chat muted on the phone (the app's keychain item
`fleetd.muted-chats`, a JSON array of `machineId/projectId`, in the group the extension shares) arrives without a
sound and passive, except an `urgent` one, which always alerts; its badge is still the hub's. If it can't open the
payload (another key, a newer version, a stranger who knows the token and posted to the relay), it sets the generic
title and body itself (`Payload.swift`) and shows nothing of what came.

**Android.** The relay sends an FCM HTTP v1 data message (`android.priority: high`, `collapse_key` when given) whose
only data is `c`. The app's messaging service opens it and posts the notification itself, one notification per chat
grouped by project, with the same buttons and badge. One that doesn't open shows nothing.

## The relay sees

The relay operator sees the device token, the ciphertext and its size, the collapse key, the platform, when each push
was sent and the IP address of the hub that sent it. It can't see any content: not the title, the body, the project,
the person or the hub's URL. It keeps nothing past the request: the rate limits count by a hash of the token and of
the source address. It logs no token or ciphertext. A stranger who knows a device token can post to the relay but
can't seal anything the phone opens: iOS shows at most the generic "fleetd: New activity", Android nothing. Its credentials come from files named in
its environment, never the repo (`FLEETD_APNS_KEY_FILE`, `FLEETD_APNS_KEY_ID`, `FLEETD_APNS_TEAM_ID`,
`FLEETD_APNS_TOPIC`, `FLEETD_APNS_SANDBOX`, `FLEETD_FCM_SERVICE_ACCOUNT`, `FLEETD_PUSH_RELAY_KEY_FILE`). How to run one:
[docs/site phone-notifications](../site/src/content/docs/phone-notifications.md).

## The app

`app/mobile/src/push.ts` registers the phone, opens a payload and says what shows for it and where a tap goes;
`src/seal.ts` is `crypto_box_seal_open` in JavaScript. The iOS extension is added at `expo prebuild` by
`plugins/notification-service`, which opens the box in Swift (`Sealed.swift`) with the key it reads from the keychain
group it shares with the app. On Android, `src/notifications.ts` handles each FCM data message in a background task
and posts the notification on a channel per kind (`quiet` for quiet hours), one per chat or request. Both open the
hub's own sealed boxes in their tests (`src/push.fixture.json`). Disconnect calls `push_device_remove`, then
`device_revoke` for the phone's own key.

## Running your own

Someone building the app under their own bundle ID can't use push.fleetd.sh: it holds only sh.fleetd.app's keys.
They run `fleetd push-relay` with their own credentials, with `FLEETD_PUSH_RELAY_KEY_FILE` whenever it is reachable
beyond localhost, and point their hubs at it with `fleetd push-relay set <url> --relay-key-file <path>`.

## Later

- The relay URL on the Hub pages of the app's Settings and in the setup flow. For now it is `fleetd push-relay set`.
