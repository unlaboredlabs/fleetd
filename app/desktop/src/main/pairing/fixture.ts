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
});

const APP_PAIR = "fixture:app-pair.json";

export const fixturePairingDeps = (file: string, connect: PairingDeps["connect"]): PairingDeps => {
  const raw = z.object({ pair: PairSection.optional() }).parse(JSON.parse(readFileSync(file, "utf8")));
  const pair = raw.pair ?? {};
  let appPair = pair.appPair === undefined ? null : JSON.stringify(pair.appPair);
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
    appPairFile: APP_PAIR,
    readText: () => Promise.resolve(appPair),
    remove: () => {
      appPair = null;
      return Promise.resolve();
    },
    // Main runs on the real clock: a fixture's appPair needs a far-future expiresAt to count as fresh.
    now: Date.now,
    deviceName: () => "devbox",
  };
};
