// The team's Claude accounts on a machine that joined after they were saved, with nobody pasting them again. The app
// seals a key or token to the machines there are when it is saved; one added later would hold none, and its agents
// would ask for a personal login. So whenever a machine links, and after each save, a machine that holds an account
// seals it to the newcomer's box key (`claude_account_reseal`) and the hub relays that box to it
// (`claude_account_secret`), with the workspace key's endpoint. The hub passes the box through once and keeps only the
// fingerprint, never the value. The agents' Mac runs no claude and never gets one.
import type { ClaudeAccount, ClaudeSealedOn } from "../../shared/contracts.ts";
import { CAP_CLAUDE_RESEAL } from "../../shared/node_link.ts";
import type { Hub } from "../api/hub.ts";
import { executors } from "../executor/index.ts";
import { link } from "../link/index.ts";
import { linked, nodeCan, sessionCall } from "../link/node_port.ts";
import { store } from "../store/hub_store.ts";
import { ClaudeAccountStore } from "./index.ts";
import { CAP_CLAUDE_ACCOUNTS } from "./setup.ts";

const ready = (hub: Hub, m: string, cap: string) => linked(hub, m) && nodeCan(hub, m, cap);

const sorted = (on: ClaudeSealedOn[]) => on.sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));

/** Each account the team has, where it is held now, and its endpoint. */
function held(s: ClaudeAccountStore): [ClaudeAccount, ClaudeSealedOn[], string | undefined][] {
  const out: [ClaudeAccount, ClaudeSealedOn[], string | undefined][] = [];
  const api = s.hubApi();
  if (api) out.push([{ kind: "hub" }, api.sealedOn, api.endpoint]);
  for (const [personId, sub] of s.subscriptions()) out.push([{ kind: "person", personId }, sub.sealedOn, undefined]);
  return out;
}

/** Records that `machine` holds `account` at `fingerprint`, while the account is still the one sealed from. */
function record(s: ClaudeAccountStore, account: ClaudeAccount, machine: string, fingerprint: string): void {
  const put = (on: ClaudeSealedOn[]) =>
    on.some((x) => x.fingerprint === fingerprint) ? sorted([...on.filter((x) => x.machineId !== machine), { machineId: machine, fingerprint }]) : undefined;
  if (account.kind === "hub") {
    const api = s.hubApi();
    const on = api && put(api.sealedOn);
    if (api && on) s.putHubApi({ ...api, sealedOn: on });
  } else {
    const sub = s.subscription(account.personId);
    const on = sub && put(sub.sealedOn);
    if (sub && on) s.putSubscription(account.personId, { ...sub, sealedOn: on });
  }
}

/** Brings one account `machine` lacks to it, sealed by a machine holding it; throws why it couldn't. */
async function bring(hub: Hub, s: ClaudeAccountStore, account: ClaudeAccount, on: ClaudeSealedOn[], endpoint: string | undefined, machine: string, to: string): Promise<void> {
  const want = on[0]!.fingerprint;
  const holders = on.filter((x) => x.machineId !== machine && x.fingerprint === want && ready(hub, x.machineId, CAP_CLAUDE_RESEAL));
  const problems: string[] = [];
  for (const { machineId: from } of holders) {
    let sealed: unknown;
    try {
      sealed = (await sessionCall(hub, from, { op: "claude_account_reseal", account, to })).sealed;
    } catch (e) {
      problems.push(`${from}: ${(e as Error).message}`);
      continue;
    }
    if (typeof sealed !== "string") {
      problems.push(`${from} holds it no more`);
      continue;
    }
    const set = { sealed, ...(endpoint !== undefined ? { endpoint } : {}) };
    const got = (await sessionCall(hub, machine, { op: "claude_account_secret", account, set })).fingerprint;
    if (got !== want) throw new Error(`${machine} kept another value than ${from} sealed`);
    record(s, account, machine, want);
    return;
  }
  throw new Error(problems.length > 0 ? problems.join("; ") : "no machine holding it is online");
}

/** Brings every account to each agent machine that lacks one; quiet for a machine away or one nothing is missing on. */
async function bringAll(hub: Hub): Promise<void> {
  const s = new ClaudeAccountStore(hub.db);
  for (const m of store(hub).machinesList()) {
    if (m.agentsMac === true || !m.boxPubKey || !ready(hub, m.machineId, CAP_CLAUDE_ACCOUNTS)) continue;
    for (const [account, on, endpoint] of held(s)) {
      if (on.length === 0 || on.some((x) => x.machineId === m.machineId)) continue;
      try {
        await bring(hub, s, account, on, endpoint, m.machineId, m.boxPubKey);
      } catch (e) {
        console.warn(`claude accounts: not on ${m.machineId} yet: ${(e as Error).message}`);
      }
    }
  }
}

const queue = new WeakMap<Hub, Promise<void>>();

/** Brings the team's accounts to every machine lacking one, one pass at a time per hub; resolves when this pass is done. */
export function spread(hub: Hub): Promise<void> {
  const next = (queue.get(hub) ?? Promise.resolve()).then(() => bringAll(hub));
  queue.set(hub, next);
  return next;
}

/** Spreads the accounts whenever a machine's link is live: it may be one that joined since they were saved. */
export function start(hub: Hub): void {
  link(hub).onLinked(({ machineId }) => {
    void executors(hub)
      .awaitLive(machineId, hub.shutdown.signal)
      .then(() => spread(hub))
      .catch(() => {});
  });
}
