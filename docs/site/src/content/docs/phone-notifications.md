---
title: Phone notifications
description: Run the push relay with your own Apple and Firebase credentials, and point a hub at it. Notifications are end-to-end encrypted.
---

The fleetd phone app shows full notifications: a Navi's reply, a lead's message, an approval waiting for you, an
order that landed or stopped. They are end-to-end encrypted. The hub seals each one to your phone's own key, and only
the phone can open it.

Apple and Google deliver a push only for the app's publisher, so a hub can't reach your phone directly. It goes
through a **push relay**: `fleetd push-relay`, run by whoever builds and signs the app, with that publisher's
credentials. The relay sees a device token and ciphertext, never the text. fleetd runs no relay for you.

## What you need {#needs}

- **iOS**: an APNs auth key (a `.p8` file) from your Apple developer account (Certificates, IDs & Profiles › Keys,
  with Apple Push Notifications service), its key ID, your team ID, and the bundle ID your app build uses.
- **Android**: a Firebase project with the app registered, and a service account JSON key from it (Project settings ›
  Service accounts › Generate new private key).

Either one is enough to start the relay. A platform without credentials is refused.

## Run the relay {#run}

On any machine your hubs can reach, such as the hub machine itself:

```sh
export FLEETD_APNS_KEY_FILE=~/keys/AuthKey_ABC123DEFG.p8
export FLEETD_APNS_KEY_ID=ABC123DEFG
export FLEETD_APNS_TEAM_ID=TEAM123456
export FLEETD_APNS_TOPIC=com.example.fleetd     # the app's bundle ID
# export FLEETD_APNS_SANDBOX=1                  # for development builds from Xcode
export FLEETD_FCM_SERVICE_ACCOUNT=~/keys/firebase-relay.json

fleetd push-relay --listen 127.0.0.1:4795
```

It prints which platforms are on. Keep the key files out of any repo, readable only by the user that runs the relay.
`curl http://127.0.0.1:4795/` answers `{"ok":true,"apns":true,"fcm":true}`.

`FLEETD_APNS_SANDBOX` must match the builds your phones run: `1` for development builds from Xcode, unset for
TestFlight and release builds. Until a push has gone through, the relay treats an APNs or Firebase answer that could
mean its own setup is wrong (another environment, bundle ID or Firebase project) as its failure, not the phone's, and
the hub keeps the phone and logs what to fix.

### Relay key {#key}

A relay anyone can reach sends its generic alert to any token they know. To take only your hubs, give it a key: a
file holding a long random string, outside any repo.

```sh
openssl rand -hex 32 > ~/keys/push-relay.key
chmod 600 ~/keys/push-relay.key
export FLEETD_PUSH_RELAY_KEY_FILE=~/keys/push-relay.key
```

It then refuses a push without `Authorization: Bearer <key>` with 401. Give the same file to each hub that uses it
(below). Use a key whenever the relay listens on more than `127.0.0.1`.

To keep it running, use a systemd user unit with the same variables in `Environment=` lines or an
`EnvironmentFile=`. If hubs on other machines use it, listen on the tailnet address (`--listen 100.x.y.z:4795`) or
put it behind HTTPS.

## Point a hub at it {#hub}

On the hub machine:

```sh
fleetd push-relay set http://127.0.0.1:4795
fleetd push-relay set http://100.x.y.z:4795 --relay-key-file ~/keys/push-relay.key
fleetd push-relay set off       # no more phone notifications
```

`--relay-key-file` seals the relay's key to the hub on your machine. The hub keeps it sealed and sends it with every
push. Setting the URL again without it drops the key.

From another machine, add `--hub <url> --key-file <path>` with a key that has admin on every machine. Each person then
turns notifications on in the phone app, which registers the phone with the hub.

## What is sent, and to whom {#what}

- A Navi's messages and approvals go to its owner only.
- A project lead's messages go to the person who last wrote in that project's chat, else the hub's owner.
- Approvals, failed fetches, machines down under running work and usage limits: what the hub already marks as
  needing you. Money and irreversible commands are urgent.
- Orders that landed or stopped.
- During the hub's quiet hours a notification arrives without a sound, unless it is urgent.

A phone signed out of the hub, or whose person was removed, gets nothing more.

## Limits {#limits}

The relay takes a ciphertext of at most 3500 characters and 60 pushes a minute to one device. It keeps nothing and
logs no token or ciphertext. When Apple or Google say a token is no longer valid (the app was removed), the relay
tells the hub, and the hub forgets that phone. If one notification would drop more than half of a
person's phones, or their only one, the hub keeps them and logs that the relay's setup is the likelier cause. The hub logs
each relay failure once an hour at most.

The wire format and the encryption are in
[docs/design/push.md](https://github.com/unlaboredlabs/fleetd/blob/main/docs/design/push.md).
