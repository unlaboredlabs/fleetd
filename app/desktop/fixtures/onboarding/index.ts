// F10: one fixture per connect-screen state, so the gate shoots each. Pairing reads each fixture's `pair` section
// (src/main/pairing/fixture.ts) instead of app-pair.json and the network; none of these has a saved key.
import { explainLoss } from "../../src/main/hub/explain.ts";
import { Fixture, HUB, PROTOCOL } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject } from "../kit/json.ts";

const healthz = (protocol = PROTOCOL): JsonObject => ({ ok: true, version: "0.5.0", protocol });
const FRESH = "2099-01-01T00:00:00Z";
const appPair = (hub: string, expiresAt = FRESH): JsonObject => ({ hub, code: "ABCD-2345", expiresAt });
const refuse = (status: number, code: string, message: string, fix: string): JsonObject => ({ status, body: { code, message, fix } });
const NEW_CODE = "Run `fleetd pair` on the hub for a new code.";

/** Every chat state in `value` reads as a chat with no messages that waits on nobody. */
const emptyChats = (value: unknown): void => {
  if (Array.isArray(value)) {
    for (const item of value) emptyChats(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const o = value as Record<string, unknown>;
  if (typeof o["lastSeq"] === "number" && "projectRef" in o) {
    o["lastSeq"] = 0;
    o["needsYou"] = false;
    delete o["lastMessageAt"];
  }
  for (const v of Object.values(o)) emptyChats(v);
};

const unpaired = (name: string, note: string, pair?: JsonObject, stateNote?: string): Fixture => {
  const f = new Fixture(`onboarding-${name}`, note);
  f.state = stateNote === undefined ? { phase: "unpaired" } : { phase: "unpaired", note: stateNote };
  f.pair = pair;
  return f;
};

export default defineGroup({
  // The frame's banner names nodes older than the hub; it learns the hub's version from /healthz.
  extend: {
    "node-too-old": (f) => {
      f.pair = { healthz: healthz() };
    },
  },
  fixtures: (base) => [
    (() => {
      // Every chat is still empty, so the checklist's last step, say hi to its lead, is the current one.
      const f = Fixture.from(base("chat-empty"), "onboarding-first-chat", "Just set up: no messages in any chat yet.");
      emptyChats([f.snapshot, f.events, f.timeline, f.calls]);
      return f;
    })(),
    unpaired("first-run", "First launch, no hub on this computer: the form with the no-hub line."),
    unpaired("code-refused", "First launch, no hub on this computer; a hub elsewhere refuses the typed code.", {
      redeem: refuse(401, "pair_code_invalid", "That pairing code is unknown or was already used.", NEW_CODE),
    }),
    unpaired("local-hub", "First launch with a hub on this computer: the found-your-hub line.", { healthz: healthz() }),
    unpaired("link", "Opened from a fleetd://pair link (the route carries hub and code): filled in, not sent.", { healthz: healthz() }),
    unpaired("app-pair", "fleetd init left a code, the hub says it was already used: auto-pair fails with the hub's fix.", {
      appPair: appPair("http://127.0.0.1:4790"),
      healthz: healthz(),
      redeem: refuse(401, "pair_code_invalid", "That pairing code is unknown or was already used.", NEW_CODE),
    }),
    unpaired("app-pair-expired", "fleetd init's code ran out before the app opened.", { appPair: appPair("http://127.0.0.1:4790", "2026-10-19T09:00:00Z"), healthz: healthz() }),
    unpaired("app-pair-untrusted", "An app-pair.json naming a public hub: ignored, with why.", { appPair: appPair("https://hub.example.com") }),
    unpaired("rate-limited", "Too many wrong codes from this address: the hub's wait-a-minute fix.", {
      appPair: appPair("http://127.0.0.1:4790"),
      healthz: healthz(),
      redeem: refuse(429, "pair_rate_limited", "Too many pairing attempts from this address.", "Wait a minute, then try again."),
    }),
    unpaired("unreadable-key", "The saved key's encryption changed under it: the note, then the form.", undefined, "The saved key couldn't be read. Pair again to continue."),
    unpaired("file-store", "Linux with no keyring: the key would go to a private file, and the form says so and how to change it.", {
      store: {
        kind: "file",
        path: "/home/dev/.config/fleetd/desktop-hub.json",
        why: "No keyring (Secret Service) is running on this computer.",
        fix: "Install and unlock GNOME Keyring or KWallet, restart the app, and pair again to keep the key there.",
      },
    }),
    (() => {
      // Tailnet names count as leaks here, so the Tailscale wording is covered by explain.test.ts instead.
      const f = new Fixture("onboarding-not-found", "A saved hub whose name doesn't resolve from here.");
      f.state = { phase: "retrying", hub: HUB, ...explainLoss(HUB, 1006, "", { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND devbox" }, false), retryAt: Date.parse(f.now) + 16_000 };
      return f;
    })(),
    (() => {
      const f = new Fixture("onboarding-app-too-old", "A hub on a newer protocol than this app.");
      f.state = { phase: "live", hub: HUB, protocol: PROTOCOL + 1 };
      return f;
    })(),
    (() => {
      const f = new Fixture("onboarding-hub-too-old", "A hub on an older protocol than this app.");
      f.state = { phase: "live", hub: HUB, protocol: PROTOCOL - 1 };
      return f;
    })(),
  ],
});
