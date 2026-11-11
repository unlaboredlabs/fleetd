# app/mobile

The fleetd phone app: Expo and React Native, iOS and Android. What it does for its users, and how to build it on
GitHub, is in [docs/site/src/content/docs/mobile.md](../../docs/site/src/content/docs/mobile.md).

In this directory, with Node 24: `npm ci`, then `npm run typecheck` and `npm test` (vitest), which CI's `mobile`
job runs. The phone's JavaScript engine (Hermes) lacks some newer built-ins, such as
`Array.prototype.toSorted`: check a new one before using it (`src/hermes.test.ts`).

## On a simulator

Phone changes are judged in a real iOS simulator, on the agents' Mac (`mac --help`). Build the app there, as the
iOS workflow (ios.yml) does:

```sh
mac sim start          # all in use: try again in a minute
mac push
mac run -- 'cd app/mobile && npm ci --no-audit --no-fund && npx expo prebuild --platform ios --clean &&
  xcodebuild -workspace ios/fleetd.xcworkspace -scheme fleetd -configuration Release -sdk iphonesimulator \
    -destination "generic/platform=iOS Simulator" CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= build | tail -n 30'
agent-device install ../DerivedData/Build/Products/Release-iphonesimulator/fleetd.app
```

`mac sim end` when done, so the next agent gets the simulator.

## A hub to pair with

For a hub with real-looking data, never the live hub:

```sh
scripts/phone-lab.sh up      # from the repo root, on the devbox
```

It starts a throwaway hub and node of their own under `$TMPDIR/phone-lab` (their own `FLEETD_HOME` and `HOME`, no
service, the factory lab's offline fleet), the hub on the devbox's tailnet address so the Mac reaches it. It seeds
four projects (two with a picture), chats with the person's messages and the lead's replies, and an order waiting on
an approval in inventory's chat. No real claude runs: the leads are the lab's claude stand-in, which answers a new
message `lab-ok`.

It prints a pairing code, the hub address, and the line that opens the pairing link in your simulator, with the app
installed:

```sh
mac run -- 'xcrun simctl --set "$FLEETD_MAC_SIM_SET" openurl "$FLEETD_MAC_SIM" "fleetd://pair?hub=…&code=…"'
```

The app asks to pair with that hub; once it has, the chats list shows the four projects. A code works once, for 15
minutes: `scripts/phone-lab.sh pair` prints a new one. `scripts/phone-lab.sh down` stops only what `up` started and
deletes its folder.
