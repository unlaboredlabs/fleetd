# Phone notifications, end-to-end encrypted

D218. Phone notifications show the full text, like a chat app's, and only the phone can read them. The phone makes an
X25519 key pair when it pairs and registers its push token and public key with the hub. The hub seals each
notification to that key and posts the ciphertext to a push relay. The relay is `fleetd push-relay`: open source,
run by whoever holds the app's Apple and Firebase credentials. It forwards the ciphertext to APNs or FCM without
reading it. On the phone, the iOS Notification Service Extension or the Android message handler opens it and shows
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
| `push_relay_set` | `{url, key?}` (empty URL: none) | `{url?, key}` |

- `token`: the APNs device token as hex, or the FCM registration token.
- `publicKey`: the phone's 32-byte X25519 public key in standard base64.
- `device`: `{deviceId: "pd_…", platform, name, createdAt, lastSentAt?}`. The token and key are never returned.
- `relay`: whether the hub has a relay set. Without one it sends nothing.
- Registering the same token again updates that device (a new key or name) and moves it to the caller's person. The
  app registers again whenever the OS gives it a new token, and removes the device when the person signs out.
- At most 20 devices per person.
- `push_relay_set` needs Admin on every machine: an owner or admin, or `fleetd push-relay set` on the hub. `key` is
  the relay's key sealed (`crypto_box_seal`) to the hub's `boxPubKey` from `hub_links_get`; the hub keeps it sealed
  to itself and sends it as `Authorization: Bearer`. The call replaces the whole setting: a URL without `key` drops
  the key. The output's `key` says whether one is kept.

A device whose key is revoked (signed out under Settings › You), or whose person was removed, gets nothing.

## Keys and sealing

- The phone makes the key pair with libsodium's `crypto_box_keypair` when it pairs with a hub. The secret key stays
  on the phone: on iOS in the Keychain, in an access group the Notification Service Extension shares; on Android in
  storage encrypted with a Keystore key.
- The hub seals with `crypto_box_seal`: an ephemeral X25519 key, XSalsa20-Poly1305, and the nonce from
  BLAKE2b(ephemeral key ‖ device key). The phone opens it with `crypto_box_seal_open`. The sealed box is the
  plaintext plus 48 bytes, sent as standard base64.
- A phone paired with several hubs uses one key pair per hub, or the same one for all. The payload's `hub` says
  which hub sent it.

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
| `v` | 1. A phone shows its generic text for a version it doesn't know. |
| `kind` | `message` (a Navi's or lead's chat message), `approval` (a request waiting for an answer), `order` (an order landed or stopped), `alert` (anything else marked for the person). An app shows an unknown kind as `alert`. |
| `title` | The Navi's or project's title, or "fleetd". |
| `body` | The message's text on one line, or the event's summary. |
| `hub` | The hub's URL. |
| `machineId`, `projectId` | The project it is about: tapping it opens that chat. Absent for an event about no project. |
| `threadId`, `messageId` | When the event names them. |
| `requestId` | `approval`: the request (`Q…`) to answer with `approval_answer`. |
| `urgent` | `true` for money or irreversible commands: show it even in a Focus (iOS `time-sensitive`). |
| `quiet` | `true` inside the hub's quiet hours (`policy.quiet_hours`): show it without a sound. |
| `at` | When the event happened. |

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
| 400 / 401 / 413 / 429 / 502 / 503 `{"status": "failed", "error"}` | Malformed, no or the wrong relay key, too big (ciphertext over 3500 characters, body over 8 KB), more than 60 pushes a minute to one token, an upstream failure, or a platform the relay has no credentials for. |

`dead` is only an answer that means that token alone is gone: APNs 410 (Unregistered); APNs BadDeviceToken or
DeviceTokenNotForTopic once a push has gone through since the relay started (before that they are what every token
gets with the wrong `FLEETD_APNS_SANDBOX` or `FLEETD_APNS_TOPIC`); FCM UNREGISTERED. The relay's setup errors
(BadTopic, TopicDisallowed, InvalidProviderToken, FCM SENDER_ID_MISMATCH, 401, 403, a 404 without UNREGISTERED) are
`failed`, with what to fix in `error`. As a backstop, when one notification's answers would drop more than half of a
person's devices, or their only one, the hub keeps them all. It logs each distinct failure once an hour at most.

With `FLEETD_PUSH_RELAY_KEY_FILE` set, the relay refuses a request without `Authorization: Bearer <key>` (401).

`GET /` answers `{"ok": true, "apns": bool, "fcm": bool}`.

**iOS.** The relay sends an APNs alert (`apns-push-type: alert`, priority 10) with token auth from the publisher's
.p8 key:

```json
{"aps": {"alert": {"title": "fleetd", "body": "New activity"}, "mutable-content": 1, "sound": "default"}, "c": "<ciphertext>"}
```

The Notification Service Extension opens `c` and sets the title and body. It sets `threadIdentifier` to
`machineId/projectId`, drops the sound when `quiet`, and sets the interruption level to time-sensitive when
`urgent`. If it can't open the payload, the generic alert shows.

**Android.** The relay sends an FCM HTTP v1 data message (`android.priority: high`, `collapse_key` when given) whose
only data is `c`. The app's messaging service opens it and posts the notification itself, one notification per chat
grouped by project.

## The relay sees

The relay sees a token, the ciphertext, the collapse key and the platform. It keeps nothing past the request: the
rate limit counts by a hash of the token. It logs no token or ciphertext. Its credentials come from files named in
its environment, never the repo (`FLEETD_APNS_KEY_FILE`, `FLEETD_APNS_KEY_ID`, `FLEETD_APNS_TEAM_ID`,
`FLEETD_APNS_TOPIC`, `FLEETD_APNS_SANDBOX`, `FLEETD_FCM_SERVICE_ACCOUNT`, `FLEETD_PUSH_RELAY_KEY_FILE`). How to run one:
[docs/site phone-notifications](../site/src/content/docs/phone-notifications.md).

## Later

- The app's Notification Service Extension and Android handler (`app/mobile`).
- The relay URL on the Hub pages of the app's Settings and in the setup flow. For now it is `fleetd push-relay set`.
