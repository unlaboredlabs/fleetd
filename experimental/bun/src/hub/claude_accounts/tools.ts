// The Claude account tools (crates/fleetd/src/hub/claude_accounts/tools.rs). The hub's: claude_hub_api_set,
// claude_hub_api_remove and claude_settings_set, for an owner's or admin's device. A person's own:
// claude_subscription_set, claude_subscription_remove and claude_choice_set. claude_accounts_get for everyone, and
// claude_account_test for whoever may change the account it tries.
//
// A key or token comes sealed to each machine's box key; the hub relays each box to its node and records the
// fingerprint it answers. The boxes are never stored, logged or returned, and no agent key reaches these tools.
import type { ClaudeAccount, ClaudeSeal, ClaudeSealedOn, ClaudeTest, Person } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { isSealedSecret } from "../approvals/sink.ts";
import { endpointChanged, endpointOn } from "../cloud/claude.ts";
import { linked, nodeCan, offline, sessionCall } from "../cloud/node.ts";
import { missed } from "../cloud/outbox.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { accountKey, ClaudeAccountStore } from "./index.ts";
import { accountRemoved, activePeople, administrator, me as person, refOf } from "./people.ts";

export const CAP_CLAUDE_ACCOUNTS = "claude_accounts";
const STARTED_NEXT = "Agents started from now on run this way; a running agent keeps the account it started on.";

export function register(tools: Registry): void {
  tools.add("claude_accounts_get", (hub, caller) => {
    requireRole(caller, "read");
    const setup = accounts(hub).setup();
    const admin = administrator(hub, caller) !== undefined;
    let mine: Person | undefined;
    try {
      mine = me(hub, caller);
    } catch {
      mine = undefined;
    }
    return {
      leadsRunOn: setup.runsOn({ hub: true }),
      ...(setup.hubApi ? { hubApi: setup.hubApi } : {}),
      settings: setup.settings,
      ...(mine ? { me: setup.person(mine) } : {}),
      people: admin ? activePeople(hub.db.conn).map((p) => setup.person(p)) : [],
    };
  });

  tools.add("claude_hub_api_set", async (hub, caller, input) => {
    const by = requireAdministrator(hub, caller);
    const seals = checkSeals(input.sealed ?? []);
    const endpoint = input.endpoint;
    if (endpoint !== undefined && !/^https?:\/\/[^\s]{1,500}$/.test(endpoint)) {
      throw new ToolError("invalid", "endpoint must be an http:// or https:// URL of at most 500 characters, no spaces.");
    }
    const s = accounts(hub);
    const before = s.hubApi();
    if (seals.length === 0 && !before) {
      throw new ToolError("invalid", "The hub has no API key to keep.", "Paste the key: the app seals it to each machine.");
    }
    const [held, problems] = await relay(hub, { kind: "hub" }, seals, endpoint, before?.sealedOn ?? []);
    if (held.length === 0) throw noneTook(problems);
    // A new key or endpoint was never tried.
    const api = {
      ...(endpoint !== undefined ? { endpoint } : {}),
      sealedOn: held,
      updatedAt: isoMs(hub.clock.now()),
      updatedBy: refOf(by),
    };
    s.putHubApi(api);
    endpointChanged(hub);
    return {
      hubApi: api,
      missingOn: missingOn(hub, api.sealedOn),
      next: withProblems(`${STARTED_NEXT} Press Test to try it with one tiny claude call.`, problems),
    };
  });

  tools.add("claude_hub_api_remove", async (hub, caller) => {
    requireAdministrator(hub, caller);
    const s = accounts(hub);
    const before = s.hubApi();
    if (before) {
      s.removeHubApi();
      endpointChanged(hub);
      await forget(hub, { kind: "hub" }, before.sealedOn.map((x) => x.machineId));
    }
    return {
      ok: true,
      next:
        "Leads and work nobody started run on the hub owner's subscription from their next start, else each " +
        "machine's own login; people who used the hub's API connect their own subscription.",
    };
  });

  tools.add("claude_settings_set", (hub, caller, input) => {
    requireAdministrator(hub, caller);
    if (typeof input.membersUseHubApi !== "boolean") throw new ToolError("invalid", "membersUseHubApi is true or false.");
    const s = accounts(hub);
    s.setSettings({ membersUseHubApi: input.membersUseHubApi });
    return { settings: s.settings(), next: STARTED_NEXT };
  });

  tools.add("claude_subscription_set", async (hub, caller, input) => {
    const p = me(hub, caller);
    const seals = checkSeals(input.sealed ?? []);
    const s = accounts(hub);
    const account: ClaudeAccount = { kind: "person", personId: p.personId };
    const [held, problems] = await relay(hub, account, seals, undefined, s.subscription(p.personId)?.sealedOn ?? []);
    if (held.length === 0) throw noneTook(problems);
    const subscription = { sealedOn: held, connectedAt: isoMs(hub.clock.now()) };
    s.putSubscription(p.personId, subscription);
    return {
      me: s.setup().person(p),
      missingOn: missingOn(hub, subscription.sealedOn),
      next: withProblems(`${STARTED_NEXT} Press Test to try it with one tiny claude call.`, problems),
    };
  });

  tools.add("claude_subscription_remove", async (hub, caller) => {
    const p = me(hub, caller);
    const s = accounts(hub);
    const before = s.subscription(p.personId);
    if (before) {
      s.removeSubscription(p.personId);
      await forget(hub, { kind: "person", personId: p.personId }, before.sealedOn.map((x) => x.machineId));
      accountRemoved(hub, refOf(p), "Claude subscription");
    }
    return { me: s.setup().person(p), next: STARTED_NEXT };
  });

  tools.add("claude_choice_set", (hub, caller, input) => {
    const p = me(hub, caller);
    const choice = input.choice;
    if (choice !== undefined && choice !== null && choice !== "subscription" && choice !== "hub_api") {
      throw new ToolError("invalid", "choice is subscription or hub_api, or absent for the default.");
    }
    const s = accounts(hub);
    s.setChoice(p.personId, choice ?? undefined);
    return { me: s.setup().person(p), next: STARTED_NEXT };
  });

  tools.add("claude_account_test", async (hub, caller, input) => {
    const s = accounts(hub);
    let account: ClaudeAccount;
    let held: ClaudeSealedOn[];
    if (input.account === "hub_api") {
      requireAdministrator(hub, caller);
      const api = s.hubApi();
      if (!api) throw new ToolError("not_found", "The hub has no API key.", "Save one first with claude_hub_api_set.");
      [account, held] = [{ kind: "hub" }, api.sealedOn];
    } else if (input.account === "mine") {
      const p = me(hub, caller);
      const subscription = s.subscription(p.personId);
      if (!subscription) {
        throw new ToolError("not_found", "You have no subscription connected.", "Paste the token `claude setup-token` prints, then test it.");
      }
      [account, held] = [{ kind: "person", personId: p.personId }, subscription.sealedOn];
    } else {
      throw new ToolError("invalid", "account is hub_api or mine.");
    }
    const machineId = holding(hub, held, input.machineId, "No machine holding it is online to test it on.", "Start a node, then test again.");
    const out = await sessionCall(hub, machineId, { op: "claude_account_test", account });
    const ok = out.ok === true;
    const said = typeof out.error === "string" ? out.error : undefined;
    const tried: ClaudeTest = { at: isoMs(hub.clock.now()), machineId, ok, ...(!ok && said !== undefined ? { error: said } : {}) };
    // Recorded on the account as it is now; one replaced or removed meanwhile keeps its own.
    if (account.kind === "hub") {
      const api = s.hubApi();
      if (api) s.putHubApi({ ...api, lastTest: tried });
    } else {
      const sub = s.subscription(account.personId);
      if (sub) s.putSubscription(account.personId, { ...sub, lastTest: tried });
    }
    return {
      test: tried,
      ...(!ok
        ? {
            next:
              account.kind === "hub"
                ? "Check the key and endpoint, then save them again."
                : "Run `claude setup-token` again and paste the new token.",
          }
        : {}),
    };
  });
}

export const accounts = (hub: Hub) => hub.area("claude_accounts", (h) => new ClaudeAccountStore(h.db));

function requireAdministrator(hub: Hub, caller: Caller): Person {
  const admin = administrator(hub, caller);
  if (!admin) {
    throw new ToolError(
      "forbidden",
      "Only the hub's owners and admins set up the hub's Claude API configuration.",
      "Ask an owner or admin; they set it on the Hub pages of the app's Settings.",
    );
  }
  return admin;
}

const me = (hub: Hub, caller: Caller) =>
  person(
    hub,
    caller,
    new ToolError(
      "forbidden",
      "Only a person connects their own Claude, from one of their own devices.",
      "Open Settings › Your accounts › Claude in the desktop app.",
    ),
  );

/** The seals of one secret: each a sealed box, no machine twice (claude_accounts.rs `seals_distinct`). */
export function checkSeals(seals: unknown): ClaudeSeal[] {
  if (!Array.isArray(seals)) throw new ToolError("invalid", "sealed is a list of { machineId, sealed }.");
  const seen = new Set<string>();
  for (const s of seals as ClaudeSeal[]) {
    if (typeof s?.machineId !== "string" || typeof s.sealed !== "string" || !isSealedSecret(s.sealed)) {
      throw new ToolError("invalid", "each seal is { machineId, sealed }, sealed a sealed box in standard base64.");
    }
    if (seen.has(s.machineId)) throw new ToolError("invalid", `${s.machineId} is sealed to twice.`);
    seen.add(s.machineId);
  }
  return seals as ClaudeSeal[];
}

/** The node can take the account's secret: online and new enough. */
function nodeReady(hub: Hub, m: string): void {
  if (!linked(hub, m)) throw offline(m);
  if (!nodeCan(hub, m, CAP_CLAUDE_ACCOUNTS)) {
    throw new ToolError("invalid", `${m}'s node is too old to run work on a Claude account.`, `Update fleetd on ${m} and restart its node.`);
  }
}

const readyOk = (hub: Hub, m: string) => {
  try {
    nodeReady(hub, m);
    return true;
  } catch {
    return false;
  }
};

/** The machine a secret is tested on: the one asked for, which must hold it, else the first online. */
function holding(hub: Hub, held: ClaudeSealedOn[], asked: string | undefined, none: string, fix: string): string {
  let m: string;
  if (asked !== undefined) {
    if (!held.some((s) => s.machineId === asked)) {
      throw new ToolError("invalid", `${asked} doesn't hold it.`, `Save it again while ${asked} is online.`);
    }
    m = asked;
  } else {
    const found = held.map((s) => s.machineId).find((x) => readyOk(hub, x));
    if (found === undefined) throw new ToolError("machine_offline", none, fix);
    m = found;
  }
  nodeReady(hub, m);
  return m;
}

/** Machines that run agents and don't hold the account: none of its work runs there. */
const missingOn = (hub: Hub, held: ClaudeSealedOn[]) =>
  store(hub)
    .machinesList()
    .map((m) => m.machineId)
    .filter((m) => !held.some((s) => s.machineId === m));

const withProblems = (next: string, problems: string[]) => (problems.length > 0 ? `${next} ${problems.join(" ")}` : next);

const noneTook = (problems: string[]) =>
  new ToolError("failed", `No machine took it. ${problems.join(" ")}`, "Seal it to the machines while they are online, then save again.");

const fingerprintOf = (out: Record<string, unknown>) => (typeof out.fingerprint === "string" ? out.fingerprint : undefined);

/**
 * Puts `account`'s secret on the machines: each of `seals`, or with none the value each machine in `before` already
 * holds, with `endpoint` as it is now. Every other machine in `before` forgets it.
 */
async function relay(
  hub: Hub,
  account: ClaudeAccount,
  seals: ClaudeSeal[],
  endpoint: string | undefined,
  before: ClaudeSealedOn[],
): Promise<[ClaudeSealedOn[], string[]]> {
  const held: ClaudeSealedOn[] = [];
  const problems: string[] = [];
  const on = (m: string) => {
    const e = endpointOn(hub, m, endpoint);
    return e !== undefined ? { endpoint: e } : {};
  };
  const sends: [string, Record<string, unknown>][] =
    seals.length === 0
      ? before.map((s) => [s.machineId, on(s.machineId)])
      : seals.map((s) => [s.machineId, { sealed: s.sealed, ...on(s.machineId) }]);
  for (const [m, set] of sends) {
    try {
      nodeReady(hub, m);
    } catch (e) {
      problems.push((e as Error).message);
      continue;
    }
    try {
      const fingerprint = fingerprintOf(await sessionCall(hub, m, { op: "claude_account_secret", account, set }));
      if (fingerprint !== undefined) held.push({ machineId: m, fingerprint });
      else problems.push(`${m} kept nothing.`);
    } catch (e) {
      problems.push(`${m}: ${(e as Error).message}`);
    }
  }
  const now = new Set(held.map((s) => s.machineId));
  await forget(hub, account, before.map((s) => s.machineId).filter((m) => !now.has(m)));
  held.sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
  return [held, problems];
}

/**
 * Each online node of `machines` forgets the account's secret. One offline keeps it unused; a sleeping cloud machine
 * forgets it as it wakes (hub/cloud).
 */
export async function forget(hub: Hub, account: ClaudeAccount, machines: string[]): Promise<void> {
  for (const m of machines) {
    if (!readyOk(hub, m)) {
      missed(hub, m, { kind: "claude_forget", account });
      continue;
    }
    try {
      await sessionCall(hub, m, { op: "claude_account_secret", account });
    } catch (e) {
      console.warn(`Claude account ${accountKey(account)} not forgotten on ${m}:`, (e as Error).message);
    }
  }
}

/** Forgets a removed person's subscription everywhere (`person_remove`): nobody's work runs on it again. */
export async function forgetPerson(hub: Hub, personId: string): Promise<void> {
  const s = accounts(hub);
  const held = s.subscription(personId)?.sealedOn;
  if (!held) return;
  await forget(hub, { kind: "person", personId }, held.map((x) => x.machineId));
  s.removeSubscription(personId);
  s.setChoice(personId, undefined);
}
