// Set up this Mac for agents under a fixture (FLEETD_FIXTURE): a Mac that isn't there, so the window's every step
// runs on any computer, for QA and the docs' captures. The hub is devbox on the tailnet; the code 000000 is wrong,
// any other is taken; the join takes a moment a step; each grant turns on a little after its pane is opened, and the
// rest of the checks are green from the start. Two codes play a version difference: 111111, an Edge hub the edge
// release has moved on past, which this app is signed in to as an admin (Update brings it level a moment later); and
// 222222, a hub newer than this app, whose answer it can't read.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MacPane } from "../shared/macSetup";
import { PANE_URLS, type MacSetupPorts } from "./macSetup";

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
  ["developer", "ada is in _developer."],
  ["xcode", "Xcode 26.1 is selected, its licence accepted."],
  ["ios_runtime", "iOS 26.1 is installed."],
  ["gui_session", "ada is at the Mac's screen."],
  ["tools", "Installing agent-device and agent-desktop…"],
  ["keep_awake", "The Mac stays awake while the node runs."],
] as const;

export const fixtureMacPorts = (): MacSetupPorts => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-mac-fixture-"));
  let joinedAt: number | undefined;
  /** The hub runs an older edge build than the Mac: 111111, until Update. */
  let behind = false;
  let hubVersion = "0.9.0";
  const asked = new Map<MacPane, number>();
  const granted = (pane: MacPane) => {
    const at = asked.get(pane);
    return at !== undefined && Date.now() - at > GRANT_MS;
  };
  const health = () => ({
    user: "ada",
    checks: [
      ...CHECKS.slice(0, 6).map(([id, message]) => ({ id, state: "ok", message })),
      granted("accessibility")
        ? { id: "accessibility", state: "ok", message: "fleetd may control this Mac." }
        : { id: "accessibility", state: "fail", message: "fleetd may not control this Mac yet.", fix: "Turn on fleetd in Privacy & Security › Accessibility." },
      granted("screen_recording")
        ? { id: "screen_recording", state: "ok", message: "fleetd may record the screen." }
        : { id: "screen_recording", state: "fail", message: "fleetd may not record the screen yet.", fix: "Turn on fleetd in Privacy & Security › Screen Recording." },
      ...CHECKS.slice(6).map(([id, message]) => ({ id, state: id === "tools" ? "unknown" : "ok", message })),
    ],
  });
  return {
    fetch: (url, init) => {
      if (!url.startsWith(HUB)) return Promise.reject(new TypeError("fetch failed"));
      if (url.endsWith("/healthz")) return Promise.resolve(json(200, { ok: true, version: hubVersion, protocol: 1 }));
      const { code } = JSON.parse(init.body as string) as { code: string };
      behind = code === "111111";
      hubVersion = behind ? OLD_EDGE : "0.9.0";
      const answer = { hubUrl: HUB, hubName: "devbox", machineId: "mac", token: "fle_fixture", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), version: hubVersion, existing: false };
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
          ? new TextEncoder().encode(`${SUM}  fleetd-darwin-arm64\n`)
          : url.endsWith("/release.json")
            ? new TextEncoder().encode(JSON.stringify({ channel: "edge", cliVersion: NEW_EDGE }))
            : BUILD,
      ),
    run: async (_file, args) => {
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
      const both = granted("accessibility") && granted("screen_recording");
      const lastGrant = Math.max(...[...asked.values()].map((at) => at + GRANT_MS));
      const checkedAt = both && Date.now() - lastGrant > 1000 ? Date.now() : joinedAt + 1500;
      if (file.endsWith("mac-health.checked")) return Promise.resolve({ text: "", writtenAt: checkedAt });
      if (file.endsWith(path.join("update", "up"))) return Promise.resolve({ text: behind ? NEW_EDGE : "0.9.0", writtenAt: joinedAt + 1500 });
      return Promise.resolve(file.endsWith("mac-health.json") ? { text: JSON.stringify(health()), writtenAt: Date.now() } : undefined);
    },
    openPane: (url) => {
      const pane = (Object.keys(PANE_URLS) as MacPane[]).find((p) => PANE_URLS[p] === url);
      if (pane !== undefined && !asked.has(pane)) asked.set(pane, Date.now());
      return Promise.resolve();
    },
    now: () => Date.now(),
    hubRole: () => Promise.resolve("admin"),
    // The hub restarts on the newer build a few seconds later.
    updateHub: () => {
      setTimeout(() => {
        hubVersion = NEW_EDGE;
      }, 4000);
      return later(400, { ok: true as const });
    },
  };
};
