// Cloud machines on boat.dev (D306) as a hub's cloud_get answers them: a pool not set up yet, and one at work. Used by
// fixtures/machines (Settings › Hub › Machines and Status) and fixtures/setup (the setup step).
import type { JsonObject } from "./json.ts";
import { at } from "./ids.ts";

const SIZES = [
  { kind: "small", perHour: 0.018 },
  { kind: "default", perHour: 0.036 },
  { kind: "large", perHour: 0.072 },
  { kind: "xlarge", perHour: 0.2 },
];

/** A hub's X25519 key, for sealing the boat key to it (the fixture never opens it). */
const BOX = "Qm9hdERldkZpeHR1cmVCb3hQdWJsaWNLZXkwMDAwMDA=";

const BASE: JsonObject = {
  hasKey: false,
  enabled: false,
  poolSize: 3,
  machineType: "large",
  dayBudget: 3,
  monthBudget: 20,
  monthIsPlan: true,
  projects: [],
  today: 0,
  month: 0,
  machines: [],
  sizes: SIZES,
  boxPubKey: BOX,
  environmentDefault: "fleetd-devbox",
  writers: false,
};

/** The public half of the hub's own SSH key, as cloud_get shows it. */
const SSH_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEZpeHR1cmVIdWJTc2hQdWJsaWNLZXkwMDAwMDAw fleetd-hub";

/** No key yet, on a hub only its tailnet reaches: what the setup step finds first. */
export const cloudNew = (over: JsonObject = {}): JsonObject => ({
  ...BASE,
  ...over,
});

/** "Sign in with boat" waiting for the person: boat.dev's link and code, the code lapsing 10 minutes after it began. */
export const cloudSignIn = (now: string): JsonObject => ({
  state: "waiting",
  email: "person@example.com",
  verificationUri: "https://boat.dev/api/box/agent/identity/claim?claim_attempt_token=fixture",
  userCode: "151323",
  expiresAtMs: Date.parse(at(now, 9 * 60_000)),
});

/** A pool at work: boat-1 awake with two agents and a screen, boat-2 asleep since the morning, boat-3 broken. */
export const cloudAtWork = (now: string, projects: JsonObject[], over: JsonObject = {}): JsonObject => ({
  ...BASE,
  hasKey: true,
  enabled: true,
  environment: "fleetd-devbox",
  projects,
  today: 0.41,
  month: 6.1,
  planDollars: 20,
  sshKey: SSH_KEY,
  pathTest: { machineId: "boat-1", ok: true, said: "boat-1: boat.dev ran it, the hub's tunnel to it came up and its node said hello through it." },
  keyTest: { ok: true, said: "Key works · $20 plan · 200 starts a day (12 a minute) · 1 of 100 machines running · large allowed" },
  machines: [
    { machineId: "boat-1", state: "awake", agents: 2, screens: 1, today: 0.29, sinceMs: Date.parse(at(now, -40 * 60_000)) },
    { machineId: "boat-2", state: "asleep", agents: 0, screens: 0, today: 0.12, sinceMs: Date.parse(at(now, -3 * 3_600_000)) },
    { machineId: "boat-3", state: "broken", agents: 0, screens: 0, today: 0, note: "no hello after two wakes" },
  ],
  ...over,
});

/** The pool's machines as the snapshot lists them, each marked cloud: awake online, the rest asleep offline. */
export const cloudSnapshotMachines = (now: string): JsonObject[] =>
  [
    ["boat-1", "online"],
    ["boat-2", "offline"],
    ["boat-3", "offline"],
  ].map(([id, status]) => ({ machineId: id ?? "", name: id ?? "", nodeVersion: "0.9.0", status: status ?? "offline", lastSeenAt: now, tags: [], cloud: true }));
