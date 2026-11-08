// The hub's Claude configuration on cloud machines, with nobody pasting it again (crates/fleetd/src/hub/cloud/
// claude.rs, D306): what the hub's own work runs on is sealed to each cloud machine's box key by a machine that already
// holds it (`claude_account_reseal`), and relayed to the cloud machine (`claude_account_secret`). The hub never holds
// a key, a token or a box beyond passing it through once; it keeps only each machine's fingerprint.
import type { ClaudeAccount, ClaudeSealedOn } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { ClaudeAccountStore } from "../claude_accounts/index.ts";
import { store } from "../store/hub_store.ts";
import { linked, nodeCan, sessionCall } from "./node.ts";

export type Brought = { nothing: true } | { current: ClaudeAccount } | { resealed: ClaudeAccount; from: string };

const CAP_CLAUDE_ACCOUNTS = "claude_accounts";
const CAP_CLAUDE_RESEAL = "claude_reseal";

/** The account the hub's own work runs on, its endpoint, and where it is held now. */
function hubAccount(hub: Hub): { account: ClaudeAccount; endpoint?: string; sealedOn: ClaudeSealedOn[] } | undefined {
  const setup = new ClaudeAccountStore(hub.db).setup();
  const on = setup.runsOn({ hub: true });
  if (on.kind !== "account") return undefined;
  const account = on.account;
  if (account.kind === "hub") {
    return { account, ...(setup.hubApi?.endpoint !== undefined ? { endpoint: setup.hubApi.endpoint } : {}), sealedOn: setup.hubApi?.sealedOn ?? [] };
  }
  return { account, sealedOn: setup.subscriptions.get(account.personId)?.sealedOn ?? [] };
}

/** Records that `machineId` holds the account with `fingerprint`, on the account as it is now. */
function record(hub: Hub, account: ClaudeAccount, machineId: string, fingerprint: string): void {
  const put = (sealedOn: ClaudeSealedOn[]) => {
    const out = sealedOn.filter((s) => s.machineId !== machineId);
    out.push({ machineId, fingerprint });
    return out.sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
  };
  const s = new ClaudeAccountStore(hub.db);
  if (account.kind === "hub") {
    const api = s.hubApi();
    if (api) s.putHubApi({ ...api, sealedOn: put(api.sealedOn) });
  } else {
    const sub = s.subscription(account.personId);
    if (sub) s.putSubscription(account.personId, { ...sub, sealedOn: put(sub.sealedOn) });
  }
}

const ready = (hub: Hub, m: string, cap: string) => linked(hub, m) && nodeCan(hub, m, cap);

/** Brings the account the hub's own work runs on to the cloud machine, sealed to its box key by a machine holding it. */
export async function bring(hub: Hub, machineId: string): Promise<Brought> {
  const held = hubAccount(hub);
  if (!held) return { nothing: true };
  const { account, endpoint, sealedOn } = held;
  const want = sealedOn.find((s) => s.machineId !== machineId)?.fingerprint;
  if (want === undefined) throw new Error("no other machine holds the hub's Claude account to seal it from");
  if (!ready(hub, machineId, CAP_CLAUDE_ACCOUNTS)) throw new Error(`${machineId}'s node takes no Claude account`);
  // Held already (an error means it holds none): only the endpoint as it is now is set.
  try {
    const have = (await sessionCall(hub, machineId, { op: "claude_account_secret", account, set: endpoint !== undefined ? { endpoint } : {} })).fingerprint;
    if (have === want) {
      record(hub, account, machineId, want);
      return { current: account };
    }
  } catch {}
  const to = store(hub).machineGet(machineId)?.boxPubKey;
  if (!to) throw new Error(`${machineId} has no box key to seal to`);
  const holders = sealedOn.filter((s) => s.machineId !== machineId && s.fingerprint === want && ready(hub, s.machineId, CAP_CLAUDE_RESEAL)).map((s) => s.machineId);
  const problems: string[] = [];
  for (const from of holders) {
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
    let got: unknown;
    try {
      got = (await sessionCall(hub, machineId, { op: "claude_account_secret", account, set: { sealed, ...(endpoint !== undefined ? { endpoint } : {}) } })).fingerprint;
    } catch (e) {
      throw new Error(`${machineId} didn't take it: ${(e as Error).message}`);
    }
    if (got !== want) throw new Error(`${machineId} kept another value than ${from} sealed`);
    record(hub, account, machineId, want);
    return { resealed: account, from };
  }
  throw new Error(problems.length === 0 ? "no machine holding the hub's Claude account is online to seal it" : problems.join("; "));
}
