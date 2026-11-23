---
title: Phone notifications
description: What the phone app notifies you about, how to act on a notification, and running your own relay.
---

This page is for phone notifications: what they show, acting on them, and turning them off.

Pair the phone and allow notifications: they just work. Each one is sealed to your phone's own key on the hub, so
only your phone can read it. They pass through fleetd's push relay, `push.fleetd.sh`, which can't read them.

## What you get {#what}

Each notification goes to the person it's for, not everyone on the bot:

- The lead's messages, to whoever started the work, or whom it's answering.
- Approvals and secrets, to whoever started the order. Work nobody started goes to the hub's owner.
- Orders that landed or stopped.
- A screen that needs you.
- For owners and admins, a [machine down](/docs/machines#down) for 10 minutes.

During the hub's quiet hours they arrive without a sound, unless urgent (money, or a command that can't be undone).

## Act from a notification {#actions}

Press and hold a notification (or swipe left on the lock screen and tap **Options**):

| Notification | Buttons |
|---|---|
| A command to approve | **Approve**, **Deny** |
| A lead's message | **Reply** |
| Money, a secret, a file edit, a send | **Review**, which opens the app |

You unlock the phone first. Approve only shows when the notification holds the whole command; anything riskier opens
the full card in the app.

The app icon's badge counts what needs you.

## What the relay sees {#sees}

- **It sees**: your phone's push token, each notification's size and time, and the hub's IP address.
- **It can't see**: any content: not the text, the bot or the person.

It keeps nothing.

## Turn notifications off {#off}

On the hub:

```sh
fleetd push-relay set off                       # no phone notifications
fleetd push-relay set https://push.fleetd.sh    # back to the default
```

To mute one phone, use its system settings. On Android, each kind (Chats, Approvals, Orders and alerts) is its own
channel.

## Run your own relay {#own}

Only needed if you [build and sign the app yourself](/docs/mobile#signing) under your own bundle id.

You need an APNs key (`.p8`) to reach iPhones, a Firebase service account JSON to reach Android phones, or both. Then:

```sh
export FLEETD_APNS_KEY_FILE=~/keys/AuthKey_ABC123DEFG.p8
export FLEETD_APNS_KEY_ID=ABC123DEFG
export FLEETD_APNS_TEAM_ID=TEAM123456
export FLEETD_APNS_TOPIC=com.example.fleetd     # your bundle id
export FLEETD_FCM_SERVICE_ACCOUNT=~/keys/firebase-relay.json
fleetd push-relay --listen 127.0.0.1:4795
```

Set `FLEETD_APNS_SANDBOX=1` only for development builds from Xcode.

### Point the hub at it {#hub}

```sh
fleetd push-relay set http://127.0.0.1:4795
```

If the relay listens on more than `127.0.0.1`, give it a key so it only takes your hubs:

```sh
openssl rand -hex 32 > ~/keys/push-relay.key
export FLEETD_PUSH_RELAY_KEY_FILE=~/keys/push-relay.key   # for the relay
fleetd push-relay set http://100.x.y.z:4795 --relay-key-file ~/keys/push-relay.key
```
