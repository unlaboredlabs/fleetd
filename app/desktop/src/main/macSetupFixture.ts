// Set up this Mac for agents under a fixture (FLEETD_FIXTURE): a Mac that isn't there, so the window's every step
// runs on any computer, for QA and the docs' captures. The hub is devbox on the tailnet; the code 000000 is wrong,
// any other is taken; the join takes a moment a step; each grant turns on a little after the node is asked for it, and the
// rest of the checks are green from the start. Two codes play a version difference: 111111, an Edge hub the edge
// release has moved on past, which this app is signed in to as an admin (Update brings it level a moment later); and
// 222222, a hub newer than this app, whose answer it can't read. 333333 joins a Mac with no Xcode yet, 444444 one whose
// Xcode-beta.app isn't selected.
//
// FLEETD_FIXTURE_MAC opens on a Mac joined already, for the menu bar's popover (menuBar.ts): `busy`, every check green
// and agents at work on storefront (two simulators and a build, beside the sessions-page fixture's Mac screen); or
// `attention`, Screen Recording lost with an update, no Xcode, no CocoaPods, a nearly full disk and a node behind the
// hub, with nothing running.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MacActivity } from "../shared/macMenuBar";
import type { MacPane } from "../shared/macSetup";
import type { MacSetupPorts } from "./macSetup";

const HUB = "http://devbox.example.ts.net:4790";
/** 111111's hub, and the newer build the edge release holds. */
const OLD_EDGE = "0.0.0-edge.202611071720+6d5a250";
const NEW_EDGE = "0.0.0-edge.202611071744+f893086";
const BUILD = new TextEncoder().encode("#!/bin/sh\nexit 0\n");
const SUM = createHash("sha256").update(BUILD).digest("hex");
const STEP_MS = 700;
const GRANT_MS = 1500;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const later = <T>(ms: number, value: T) => new Promise<T>((done) => setTimeout(() => done(value), ms));

const CHECKS = [
  ["standard_user", "ada is an administrator: allowed, as the Mac stays a tool."],
  ["other_homes", "No other user's home opens for ada."],
  ["no_apple_id", "No Apple ID is signed in."],
  ["developer", "ada is in _developer and Developer Mode is on."],
  ["xcode", "Xcode 26.1 is selected, its licence accepted."],
  ["ios_runtime", "iOS 26.1 is installed."],
  ["gui_session", "ada is at the Mac's screen."],
  ["tools", "Installing agent-device and agent-desktop…"],
  ["keep_awake", "The Mac stays awake while the node runs."],
] as const;

const WAITS = { id: "ios_runtime", state: "warn", message: "Waits for Xcode: the Xcode check says what it needs." };
/** A Mac whose Xcode isn't usable yet, by its code: the node's two checks for it, as agents_mac/checks.rs words them. */
const XCODE_WAITS: Readonly<Record<string, ReadonlyArray<object>>> = {
  "333333": [
    {
      id: "xcode",
      state: "warn",
      message: "Xcode isn't installed. iOS simulators and builds wait for it; everything else works.",
      fix: "Install Xcode from the App Store; this check looks again by itself",
      command: 'open "macappstore://apps.apple.com/app/id497799835"',
    },
    WAITS,
  ],
  "444444": [
    {
      id: "xcode",
      state: "warn",
      message:
        "Xcode-beta.app is in /Applications, but xcode-select points at /Applications/Xcode.app/Contents/Developer, which isn't there. iOS simulators and builds wait for it; everything else works.",
      fix: "In your own (admin) account's Terminal",
      command: "sudo xcode-select -s /Applications/Xcode-beta.app/Contents/Developer",
    },
    WAITS,
  ],
};

/** The sessions-page fixture's storefront, whose agents T3, T10 and T12 use the Mac. */
const STOREFRONT = "dcffccea-c5a7-40a6-940d-7f70239ffa22";
const GB = 1_000_000_000;

/** What agents do on a `busy` Mac, `at` its start. */
const busyActivity = (at: number): MacActivity => ({
  simulators: [
    { agent: "T12", projectId: STOREFRONT, device: "iPhone 17 Pro", sinceMs: at - 6 * 60_000 },
    { agent: "T3", projectId: STOREFRONT, device: "iPhone 17", sinceMs: at - 19 * 60_000 },
  ],
  jobs: [{ agent: "T10", projectId: STOREFRONT, job: 3, command: "xcodebuild test -workspace ios/Storefront.xcworkspace -scheme Storefront -destination 'platform=iOS Simulator,name=iPhone 17'", startedMs: at - 2 * 60_000 - 40_000 }],
});

/** An `attention` Mac's checks that aren't green, as agents_mac/checks.rs words them. */
const ATTENTION: ReadonlyArray<object> = [
  ...(XCODE_WAITS["333333"] ?? []),
  {
    id: "screen_recording",
    state: "fail",
    message: "macOS stopped counting fleetd's Screen Recording with the update to 0.9.2, so you and agents can't see the Mac's screen.",
    fix: "In Terminal at the Mac, then turn fleetd off and on again in System Settings › Privacy & Security › Screen Recording, which this opens once macOS has asked",
    command: "fleetd node grants --ask screen_recording",
  },
  {
    id: "tools",
    state: "warn",
    message: "Node.js 22.12.0, agent-device 0.11.2 and agent-desktop 0.4.0 are in. CocoaPods isn't installed, so pod install and expo prebuild --platform ios don't run; everything else works.",
    fix: "In your own (admin) account's Terminal",
    command: "/opt/homebrew/bin/brew install cocoapods",
  },
];

export const fixtureMacPorts = (mac: string | undefined = process.env["FLEETD_FIXTURE_MAC"]): MacSetupPorts => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-mac-fixture-"));
  const opened = mac === "busy" || mac === "attention" ? mac : undefined;
  const started = Date.now();
  // A Mac joined a while ago, with both grants given (the attention one's Screen Recording lost since).
  let joinedAt: number | undefined = opened === undefined ? undefined : started - 3_600_000;
  /** The hub runs an older edge build than the Mac: 111111, until Update. */
  let behind = false;
  let hubVersion = "0.9.0";
  /** The node's own build: behind the hub's on an `attention` Mac. */
  let macVersion = "0.9.0";
  let xcodeWaits: ReadonlyArray<object> | undefined;
  const asked = new Map<MacPane, number>(opened === undefined ? [] : [["accessibility", started - 3_600_000], ...(opened === "busy" ? [["screen_recording", started - 3_600_000] as const] : [])]);
  if (opened === "attention") hubVersion = "0.9.2";
  const granted = (pane: MacPane) => {
    const at = asked.get(pane);
    return at !== undefined && Date.now() - at > GRANT_MS;
  };
  const health = () => opened === "attention" ? attentionHealth() : ({
    user: "ada",
    checks: [
      ...CHECKS.slice(0, 4).map(([id, message]) => ({ id, state: "ok", message })),
      ...(xcodeWaits ?? CHECKS.slice(4, 6).map(([id, message]) => ({ id, state: "ok", message }))),
      granted("accessibility")
        ? { id: "accessibility", state: "ok", message: "fleetd may control this Mac." }
        : { id: "accessibility", state: "fail", message: "fleetd may not control this Mac yet.", fix: "Turn on fleetd in Privacy & Security › Accessibility." },
      granted("screen_recording")
        ? { id: "screen_recording", state: "ok", message: "fleetd may record the screen." }
        : { id: "screen_recording", state: "fail", message: "fleetd may not record the screen yet.", fix: "Turn on fleetd in Privacy & Security › Screen Recording." },
      ...CHECKS.slice(6).map(([id, message]) =>
        id === "tools" && opened === "busy"
          ? { id, state: "ok", message: "Node.js 22.12.0, agent-device 0.11.2 and agent-desktop 0.4.0 are in. CocoaPods 1.16.2." }
          : { id, state: id === "tools" ? "unknown" : "ok", message },
      ),
    ],
  });
  const attentionHealth = () => {
    const off = new Set(ATTENTION.map((c) => (c as { id: string }).id));
    const green = [...CHECKS.slice(0, 6), ["accessibility", "fleetd may control this Mac."], ...CHECKS.slice(6)].filter(([id]) => !off.has(id)).map(([id, message]) => ({ id, state: "ok", message }));
    // Granted again once the node asked and the person turned it on.
    const recording = granted("screen_recording") ? [{ id: "screen_recording", state: "ok", message: "fleetd may record the screen." }] : [];
    return { user: "ada", checks: [...green, ...ATTENTION.filter((c) => recording.length === 0 || (c as { id: string }).id !== "screen_recording"), ...recording] };
  };
  return {
    fetch: (url, init) => {
      if (!url.startsWith(HUB)) return Promise.reject(new TypeError("fetch failed"));
      if (url.endsWith("/healthz")) return Promise.resolve(json(200, { ok: true, version: hubVersion, protocol: 1 }));
      const { code } = JSON.parse(init.body as string) as { code: string };
      behind = code === "111111";
      hubVersion = behind ? OLD_EDGE : "0.9.0";
      const answer = { hubUrl: HUB, hubName: "devbox", machineId: "mac", token: "fle_fixture", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), version: hubVersion, existing: false };
      xcodeWaits = XCODE_WAITS[code];
      return later(
        600,
        code === "000000"
          ? json(401, { code: "pair_code_invalid", message: "that code isn't open on this hub", fix: "On your main machine, open Add machine › A Mac for agents for a new code, then type it here." })
          : code === "222222"
            ? json(200, { setup: 2, hub: { url: HUB } })
            : json(200, answer),
      );
    },
    download: (url) =>
      later(
        STEP_MS,
        url.endsWith("/SHA256SUMS")
          ? new TextEncoder().encode(`${SUM}  fleetd-bun-darwin-arm64\n`)
          : url.endsWith("/release.json")
            ? new TextEncoder().encode(JSON.stringify({ channel: "edge", cliVersion: NEW_EDGE }))
            : BUILD,
      ),
    run: async (_file, args) => {
      // `fleetd node grants --ask <grant>`: the node asks macOS, and the person turns it on a little later.
      if (args[0] === "node" && args[1] === "grants") {
        const pane = args[3] as MacPane;
        if (!asked.has(pane)) asked.set(pane, Date.now());
        return { code: 0, output: "" };
      }
      if (args[0] === "status") return { code: 0, output: JSON.stringify({ Peer: { a: { DNSName: "devbox.example.ts.net.", Online: true } } }) };
      await later(STEP_MS * 2, null);
      if (args[0] === "init") joinedAt = Date.now();
      return { code: 0, output: "" };
    },
    fleetdDir: dir,
    fingerprint: () => Promise.resolve("f".repeat(64)),
    baseOverride: undefined,
    platform: "darwin",
    arch: "arm64",
    knownHubs: () => [],
    tailscaleStatus: () => Promise.resolve(JSON.stringify({ Peer: { a: { DNSName: "devbox.example.ts.net.", Online: true } } })),
    // The node writes its first checks a moment after joining; it runs them all again a moment after both grants.
    readFile: (file) => {
      if (joinedAt === undefined || Date.now() - joinedAt < 1500) return Promise.resolve(undefined);
      if (file.endsWith("node.json")) {
        return Promise.resolve({ text: JSON.stringify({ enrolled: true, agentsMac: true, machineId: "mac", hub: HUB }), writtenAt: joinedAt });
      }
      if (file.endsWith("mac-activity.json")) {
        return Promise.resolve({ text: JSON.stringify(opened === "busy" ? busyActivity(started) : { simulators: [], jobs: [] }), writtenAt: Date.now() });
      }
      const both = granted("accessibility") && granted("screen_recording");
      const lastGrant = Math.max(...[...asked.values()].map((at) => at + GRANT_MS));
      // A Mac joined already runs its checks as it should.
      const checkedAt = opened !== undefined || (both && Date.now() - lastGrant > 1000) ? Date.now() : joinedAt + 1500;
      if (file.endsWith("mac-health.checked")) return Promise.resolve({ text: "", writtenAt: checkedAt });
      if (file.endsWith(path.join("update", "up"))) return Promise.resolve({ text: behind ? NEW_EDGE : macVersion, writtenAt: joinedAt + 1500 });
      return Promise.resolve(file.endsWith("mac-health.json") ? { text: JSON.stringify(health()), writtenAt: Date.now() } : undefined);
    },
    // The grants come through the CLI's ask (run, above); the App Store installs nothing here.
    openPane: () => Promise.resolve(),
    now: () => Date.now(),
    hubRole: () => Promise.resolve("admin"),
    // The hub restarts on the newer build a few seconds later; a Mac behind the hub takes its build a little after.
    updateHub: () => {
      setTimeout(() => {
        if (macVersion !== hubVersion) macVersion = hubVersion;
        else hubVersion = NEW_EDGE;
      }, 4000);
      return later(400, { ok: true as const });
    },
    disk: () => Promise.resolve(opened === "attention" ? { freeBytes: 9.4 * GB, totalBytes: 494 * GB } : { freeBytes: 182 * GB, totalBytes: 994 * GB }),
  };
};
