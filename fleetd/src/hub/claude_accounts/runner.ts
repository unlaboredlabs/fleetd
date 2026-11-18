// The team's Claude accounts on the hub's runner, with nobody saving them again. The app seals a key or token to the
// machines there are when it is saved; a runner that appears later (its provider connected afterwards) would hold none,
// and no hosted agent could start. So whenever the runner or a machine holding an account links, and after each save,
// a machine that holds it seals it to the runner's box key (`claude_account_reseal`) and the hub relays that box to the
// runner (`claude_account_secret`), with the hub key's endpoint. The hub passes the box through once and keeps only the
// fingerprint, never the value.
import type { ClaudeAccount, ClaudeSealedOn } from "../../shared/contracts.ts";
import { CAP_CLAUDE_RESEAL } from "../../shared/node_link.ts";
import { RUNNER_ID } from "../../shared/sandbox.ts";
import type { Hub } from "../api/hub.ts";
import { linked, nodeCan, sessionCall } from "../link/node_port.ts";
import { store } from "../store/hub_store.ts";
import { ClaudeAccountStore } from "./index.ts";
import { CAP_CLAUDE_ACCOUNTS } from "./setup.ts";

const ready = (hub: Hub, m: string, cap: string) => linked(hub, m) && nodeCan(hub, m, cap);

const sorted = (on: ClaudeSealedOn[]) => on.sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));

/** Each account the team has, and where it is held now. */
function held(s: ClaudeAccountStore): [ClaudeAccount, ClaudeSealedOn[], string | undefined][] {
  const out: [ClaudeAccount, ClaudeSealedOn[], string | undefined][] = [];
  const api = s.hubApi();
  if (api) out.push([{ kind: "hub" }, api.sealedOn, api.endpoint]);
  for (const [personId, sub] of s.subscriptions()) out.push([{ kind: "person", personId }, sub.sealedOn, undefined]);
  return out;
}

/** Records that the runner holds `account` at `fingerprint`, while the account is still the one sealed from. */
function record(s: ClaudeAccountStore, account: ClaudeAccount, fingerprint: string): void {
  const put = (on: ClaudeSealedOn[]) =>
    on.some((x) => x.fingerprint === fingerprint) ? sorted([...on.filter((x) => x.machineId !== RUNNER_ID), { machineId: RUNNER_ID, fingerprint }]) : undefined;
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

/** Brings one account the runner lacks to it, sealed by a machine holding it; throws why it couldn't. */
async function bring(hub: Hub, s: ClaudeAccountStore, account: ClaudeAccount, on: ClaudeSealedOn[], endpoint: string | undefined, to: string): Promise<void> {
  const want = on[0]!.fingerprint;
  const holders = on.filter((x) => x.machineId !== RUNNER_ID && x.fingerprint === want && ready(hub, x.machineId, CAP_CLAUDE_RESEAL));
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
    const got = (await sessionCall(hub, RUNNER_ID, { op: "claude_account_secret", account, set })).fingerprint;
    if (got !== want) throw new Error(`the runner kept another value than ${from} sealed`);
    record(s, account, want);
    console.info(`claude accounts: ${account.kind === "hub" ? "the hub's API key" : `${account.personId}'s subscription`} reached the hosted sandboxes from ${from}`);
    return;
  }
  throw new Error(problems.length ? problems.join("; ") : "no machine holding it is online to seal it");
}

/** Brings every account the runner lacks to it; quiet while the runner is away or nothing is missing. */
async function bringAll(hub: Hub): Promise<void> {
  if (!ready(hub, RUNNER_ID, CAP_CLAUDE_ACCOUNTS)) return;
  const to = store(hub).machineGet(RUNNER_ID)?.boxPubKey;
  if (!to) return;
  const s = new ClaudeAccountStore(hub.db);
  for (const [account, on, endpoint] of held(s)) {
    if (on.length === 0 || on.some((x) => x.machineId === RUNNER_ID)) continue;
    try {
      await bring(hub, s, account, on, endpoint, to);
    } catch (e) {
      console.warn(`claude accounts: not on the hosted sandboxes yet: ${(e as Error).message}`);
    }
  }
}

const queue = new WeakMap<Hub, Promise<void>>();

/** Brings the team's accounts to the runner, one pass at a time per hub; resolves when this pass is done. */
export function toRunner(hub: Hub): Promise<void> {
  const next = (queue.get(hub) ?? Promise.resolve()).then(() => bringAll(hub));
  queue.set(hub, next);
  return next;
}
