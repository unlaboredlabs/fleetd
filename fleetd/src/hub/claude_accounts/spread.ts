// The team's secrets on a machine that joined after they were saved, with nobody pasting them again: each Claude
// account (the workspace's API key, each person's subscription), the team's Gemini key and each person's 1Password
// token. The app seals each to the machines there are when it is saved; one added later would hold none, and its
// agents would ask for a personal login. So whenever a machine links, and after each save, a machine that holds the
// secret seals it to the newcomer's box key (`claude_account_reseal`, `gemini_key_reseal`, `onepassword_token_reseal`)
// and the hub relays that box to it as a save would, with the key's endpoint. The hub passes the box through once and
// keeps only the fingerprint, never the value. The agents' Mac runs no agents and never gets one.
import type { ClaudeAccount, ClaudeSealedOn } from "../../shared/contracts.ts";
import { CAP_CLAUDE_RESEAL, CAP_GEMINI_KEY, CAP_SECRET_RESEAL } from "../../shared/node_link.ts";
import type { Hub } from "../api/hub.ts";
import { executors } from "../executor/index.ts";
import { link } from "../link/index.ts";
import { linked, nodeCan, sessionCall } from "../link/node_port.ts";
import { CAP_ONEPASSWORD, putToken, token } from "../onepassword/index.ts";
import { store } from "../store/hub_store.ts";
import { ClaudeAccountStore } from "./index.ts";
import { CAP_CLAUDE_ACCOUNTS } from "./setup.ts";

const ready = (hub: Hub, m: string, cap: string) => linked(hub, m) && nodeCan(hub, m, cap);

const sorted = (on: ClaudeSealedOn[]) => on.sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));

/** `on` with `machine` holding the value at `fingerprint`, while it is still the value held there; else undefined. */
const holding = (on: ClaudeSealedOn[], machine: string, fingerprint: string) =>
  on.some((x) => x.fingerprint === fingerprint) ? sorted([...on.filter((x) => x.machineId !== machine), { machineId: machine, fingerprint }]) : undefined;

/** One secret the team keeps on machines, and how it moves to one more. */
type Held = {
  what: string;
  on: ClaudeSealedOn[];
  /** What a machine must say it can do to take it, and to seal it on. */
  takes: string;
  seals: string;
  reseal: (to: string) => { op: string } & Record<string, unknown>;
  /** The save that puts a box on a machine, with the key's endpoint. */
  put: (sealed: string) => { op: string } & Record<string, unknown>;
  /** Records that `machine` holds it at `fingerprint`. */
  record: (machine: string, fingerprint: string) => void;
};

/** Each secret the team keeps on machines, where it is held now. */
function held(hub: Hub, s: ClaudeAccountStore): Held[] {
  const out: Held[] = [];
  const claude = (account: ClaudeAccount, on: ClaudeSealedOn[], endpoint: string | undefined, record: Held["record"]) =>
    out.push({
      what: account.kind === "hub" ? "the workspace's Claude API key" : "a Claude subscription",
      on,
      takes: CAP_CLAUDE_ACCOUNTS,
      seals: CAP_CLAUDE_RESEAL,
      reseal: (to) => ({ op: "claude_account_reseal", account, to }),
      put: (sealed) => ({ op: "claude_account_secret", account, set: { sealed, ...(endpoint !== undefined ? { endpoint } : {}) } }),
      record,
    });
  const api = s.hubApi();
  if (api) {
    claude({ kind: "hub" }, api.sealedOn, api.endpoint, (m, fp) => {
      const now = s.hubApi();
      const on = now && holding(now.sealedOn, m, fp);
      if (now && on) s.putHubApi({ ...now, sealedOn: on });
    });
  }
  for (const [personId, sub] of s.subscriptions()) {
    claude({ kind: "person", personId }, sub.sealedOn, undefined, (m, fp) => {
      const now = s.subscription(personId);
      const on = now && holding(now.sealedOn, m, fp);
      if (now && on) s.putSubscription(personId, { ...now, sealedOn: on });
    });
  }
  const gemini = s.geminiKey();
  if (gemini) {
    const { endpoint } = gemini;
    out.push({
      what: "the team's Gemini key",
      on: gemini.sealedOn,
      takes: CAP_GEMINI_KEY,
      seals: CAP_SECRET_RESEAL,
      reseal: (to) => ({ op: "gemini_key_reseal", to }),
      put: (sealed) => ({ op: "gemini_key", set: { sealed, ...(endpoint !== undefined ? { endpoint } : {}) } }),
      record: (m, fp) => {
        const now = s.geminiKey();
        const on = now && holding(now.sealedOn, m, fp);
        if (now && on) s.putGeminiKey({ ...now, sealedOn: on });
      },
    });
  }
  for (const { person_id: personId } of hub.db.conn.query<{ person_id: string }, []>("SELECT person_id FROM onepassword_tokens").all()) {
    const t = token(hub.db, personId);
    if (!t) continue;
    out.push({
      what: "a 1Password token",
      on: t.sealedOn,
      takes: CAP_ONEPASSWORD,
      seals: CAP_SECRET_RESEAL,
      reseal: (to) => ({ op: "onepassword_token_reseal", personId, to }),
      put: (sealed) => ({ op: "onepassword_token", personId, sealed }),
      record: (m, fp) => {
        const now = token(hub.db, personId);
        const on = now && holding(now.sealedOn, m, fp);
        if (now && on) putToken(hub.db, personId, { ...now, sealedOn: on });
      },
    });
  }
  return out;
}

/** Brings one secret `machine` lacks to it, sealed by a machine holding it; throws why it couldn't. */
async function bring(hub: Hub, secret: Held, machine: string, to: string): Promise<void> {
  const want = secret.on[0]!.fingerprint;
  const holders = secret.on.filter((x) => x.machineId !== machine && x.fingerprint === want && ready(hub, x.machineId, secret.seals));
  const problems: string[] = [];
  for (const { machineId: from } of holders) {
    let sealed: unknown;
    try {
      sealed = (await sessionCall(hub, from, secret.reseal(to))).sealed;
    } catch (e) {
      problems.push(`${from}: ${(e as Error).message}`);
      continue;
    }
    if (typeof sealed !== "string") {
      problems.push(`${from} holds it no more`);
      continue;
    }
    const got = (await sessionCall(hub, machine, secret.put(sealed))).fingerprint;
    if (got !== want) throw new Error(`${machine} kept another value than ${from} sealed`);
    secret.record(machine, want);
    return;
  }
  throw new Error(problems.length > 0 ? problems.join("; ") : "no machine holding it is online");
}

/** Brings every secret to each agent machine that lacks one; quiet for a machine away or one nothing is missing on. */
async function bringAll(hub: Hub): Promise<void> {
  const s = new ClaudeAccountStore(hub.db);
  for (const m of store(hub).machinesList()) {
    if (m.agentsMac === true || !m.boxPubKey || !linked(hub, m.machineId)) continue;
    for (const secret of held(hub, s)) {
      if (secret.on.length === 0 || secret.on.some((x) => x.machineId === m.machineId) || !nodeCan(hub, m.machineId, secret.takes)) continue;
      try {
        await bring(hub, secret, m.machineId, m.boxPubKey);
      } catch (e) {
        console.warn(`${secret.what}: not on ${m.machineId} yet: ${(e as Error).message}`);
      }
    }
  }
}

const queue = new WeakMap<Hub, Promise<void>>();

/** Brings the team's secrets to every machine lacking one, one pass at a time per hub; resolves when this pass is done. */
export function spread(hub: Hub): Promise<void> {
  const next = (queue.get(hub) ?? Promise.resolve()).then(() => bringAll(hub));
  queue.set(hub, next);
  return next;
}

/** Spreads the secrets whenever a machine's link is live: it may be one that joined since they were saved. */
export function start(hub: Hub): void {
  link(hub).onLinked(({ machineId }) => {
    void executors(hub)
      .awaitLive(machineId, hub.shutdown.signal)
      .then(() => spread(hub))
      .catch(() => {});
  });
}
