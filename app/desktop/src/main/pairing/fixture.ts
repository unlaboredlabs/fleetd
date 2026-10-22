// Under FLEETD_FIXTURE the connect screen must not touch the network, nor a real app-pair.json. A fixture may carry
// a `pair` section (ignored by the hub fixture's schema) that stands in for app-pair.json, /healthz and /pair, so the
// QA gate shoots the real pairing path, failure and all.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { PairingDeps } from "./service";

const PairSection = z.object({
  /** The app-pair.json `fleetd init` would have left. */
  appPair: z.object({ hub: z.string(), code: z.string(), expiresAt: z.string() }).optional(),
  /** /healthz's body; absent: no hub answers. */
  healthz: z.json().optional(),
  /** /pair's answer; absent: the hub can't be reached. */
  redeem: z.object({ status: z.int().min(100).max(599), body: z.json() }).optional(),
  /** The terminal "Set up fleetd" opens; absent: none could be opened. Nothing is ever run. */
  terminal: z.string().optional(),
  /** Where the key would be kept; absent: the OS store. */
  store: z
    .union([
      z.object({ kind: z.literal("os"), where: z.string() }),
      z.object({ kind: z.literal("file"), path: z.string(), why: z.string(), fix: z.string() }),
      z.object({ kind: z.literal("env") }),
    ])
    .optional(),
});

const APP_PAIR = "fixture:app-pair.json";

export const fixturePairingDeps = (file: string, connect: PairingDeps["connect"], firstRun: () => boolean): PairingDeps => {
  const raw = z.object({ pair: PairSection.optional() }).parse(JSON.parse(readFileSync(file, "utf8")));
  const pair = raw.pair ?? {};
  const appPair = pair.appPair === undefined ? null : JSON.stringify(pair.appPair);
  const answer = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  return {
    fetch: (url) => {
      const path = new URL(url).pathname;
      if (path === "/healthz" && pair.healthz !== undefined) return answer(200, pair.healthz);
      if (path === "/pair" && pair.redeem !== undefined) return answer(pair.redeem.status, pair.redeem.body);
      return Promise.reject(new TypeError("fetch failed"));
    },
    connect,
    firstRun,
    appPairFile: APP_PAIR,
    readFile: () => Promise.resolve(appPair === null ? { ok: false, missing: true } : { ok: true, text: appPair }),
    // A fixture replays the same on every load (the QA harness reloads after pinning the clock), so nothing is spent.
    remove: () => Promise.resolve(),
    // Main runs on the real clock: a fixture's appPair needs a far-future expiresAt to count as fresh.
    now: Date.now,
    deviceName: () => "devbox",
    keyStore: pair.store ?? { kind: "os", where: "the OS keychain" },
    openSetup: () =>
      Promise.resolve(
        pair.terminal === undefined
          ? { ok: false, message: "Couldn't open a terminal. Run this in one:", command: "fleetd init" }
          : { ok: true, terminal: pair.terminal },
      ),
  };
};
