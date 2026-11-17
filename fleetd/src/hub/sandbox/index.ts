// The team's own hosted sandbox accounts (W688): per provider (E2B, boat.dev, Daytona) an API key, which an admin's
// app seals to the hub's box key and the hub keeps sealed under the vault's root key as it keeps a vault item (table
// `sandbox_providers`); for E2B an optional domain (a self-hosted E2B); and a limit, how many of the team's agents may
// run there at once. The key never leaves in the clear: a machine of the team's that creates agents' sandboxes gets it
// sealed to its own box key (`sealedTo`) for a check of it (`test`), never into an agent's session. The hub knows no
// provider's API: the node's client asks. Every use is logged, without the key.
//
// Placement is by count alone: a machine's own slots first, then the connected providers in ORDER up to each
// one's limit, then the queue. The limits reach the team's machines (`sandbox_limits`), whose nodes report what they
// can make boxes in (`load.sandboxes`), and the slot board (hub/slots/board.ts) counts each provider's limit across
// all of them. With the limits each machine gets the keys, sealed to its own box key: its node makes the boxes.
import type { KnownSandboxProvider, SandboxCheck, SandboxProviderState, SandboxState } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { NodeActionResult } from "../../shared/node_link.ts";
import { CAP_SANDBOX, CHECK_WAIT, checkFix, DEFAULT_LIMIT, domainOf, isProvider, type Limit, MAX_LIMIT, NAMES, ORDER, reasonOf } from "../../shared/sandbox.ts";
import { publicKeyOf, seal } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { isoMs } from "../auth/index.ts";
import { boxKey } from "../hub_links/store.ts";
import { link } from "../link/index.ts";
import { slots } from "../slots/index.ts";
import { store } from "../store/hub_store.ts";
import { openRawToHub } from "../vault/items.ts";
import { vault } from "../vault/index.ts";
import { keyIdOf, openItem, sealItem } from "../vault/crypto.ts";

/** Whether the team's machines place agents in hosted sandboxes once their own slots are full. */
export const PLACING = true;

/** A key's envelope is bound to its provider's row, as a vault item's is to its own. */
const binding = (provider: KnownSandboxProvider) => ({ itemId: `sandbox:${provider}`, kind: "sandbox_key", scopeKey: "hub", version: 1 });

type Row = { provider: string; sealed: Uint8Array; domain: string | null; max_agents: number; check_json: string | null };

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function rows(hub: Hub): Row[] {
  return hub.db.conn.query<Row, []>("SELECT provider, sealed, domain, max_agents, check_json FROM sandbox_providers").all();
}

const rowOf = (hub: Hub, provider: KnownSandboxProvider): Row | undefined => rows(hub).find((r) => r.provider === provider);

function known(provider: string): KnownSandboxProvider {
  if (isProvider(provider)) return provider;
  throw new ToolError("invalid", `provider is ${ORDER.join(", ")}, not ${provider}.`);
}

function checkOf(r: Row): SandboxCheck | undefined {
  try {
    return r.check_json ? (JSON.parse(r.check_json) as SandboxCheck) : undefined;
  } catch {
    return undefined;
  }
}

export function state(hub: Hub): SandboxState {
  const all = rows(hub);
  const providers = ORDER.map((p): SandboxProviderState => {
    const r = all.find((x) => x.provider === p);
    if (!r) return { provider: p, connected: false, limit: 0 };
    const check = checkOf(r);
    return { provider: p, connected: true, limit: r.max_agents, ...(r.domain ? { domain: r.domain } : {}), ...(check ? { check } : {}) };
  });
  return { boxPubKey: b64(publicKeyOf(boxKey(hub))), placing: PLACING, providers };
}

/** The connected providers' limits, in the order agents go to them. */
export function limits(hub: Hub): Limit[] {
  const all = rows(hub);
  return ORDER.flatMap((p) => {
    const r = all.find((x) => x.provider === p);
    return r ? [{ provider: p, max: r.max_agents }] : [];
  });
}

function limitOf(n: unknown): number {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_LIMIT) {
    throw new ToolError("invalid", `limit is a whole number from 0 to ${MAX_LIMIT}.`);
  }
  return n;
}

/** The vault's root key now, or why a key can't be sealed or opened. */
async function rootKey(hub: Hub): Promise<{ id: string; key: Uint8Array }> {
  const v = vault(hub);
  await v.load();
  try {
    return v.keys.active();
  } catch (e) {
    throw new ToolError(
      "failed",
      `The vault's key isn't available (${(e as Error).message}), so the provider's key can't be kept sealed.`,
      "unlock the vault in Settings › Vault, then try again",
    );
  }
}

/** Keeps `sealed` (`{"key": "…"}` sealed to the hub's box key) as the team's key for `provider`, then checks it. */
export async function connect(hub: Hub, input: { provider: string; sealed: string; domain?: string; limit?: number }): Promise<SandboxState> {
  const provider = known(input.provider);
  let domain: string | null = null;
  if (input.domain !== undefined && input.domain.trim() !== "") {
    if (provider !== "e2b") throw new ToolError("invalid", `Only E2B takes a domain, not ${NAMES[provider]}.`);
    domain = domainOf(input.domain);
    if (domain === null) throw new ToolError("invalid", `${input.domain} isn't a domain.`, "give the self-hosted E2B's domain, such as e2b.example.com, or none for E2B's own");
  }
  const limit = input.limit === undefined ? (rowOf(hub, provider)?.max_agents ?? DEFAULT_LIMIT) : limitOf(input.limit);
  const bytes = openRawToHub(hub, input.sealed);
  let key: string;
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as { key?: unknown };
    key = typeof parsed.key === "string" ? parsed.key.trim() : "";
  } catch {
    key = "";
  } finally {
    bytes.fill(0);
  }
  if (!key || /\s/.test(key) || key.length > 1024) {
    throw new ToolError("invalid", `The sealed value holds no ${NAMES[provider]} API key.`, `Seal {"key":"<your ${NAMES[provider]} API key>"} to boxPubKey.`);
  }
  const root = await rootKey(hub);
  const boxed = sealItem(root.key, root.id, binding(provider), new TextEncoder().encode(key));
  hub.db.conn
    .query(
      `INSERT INTO sandbox_providers (provider, sealed, domain, max_agents, check_json) VALUES (?1, ?2, ?3, ?4, NULL)
       ON CONFLICT (provider) DO UPDATE SET sealed = excluded.sealed, domain = excluded.domain, max_agents = excluded.max_agents, check_json = NULL`,
    )
    .run(provider, boxed, domain, limit);
  console.info(`sandbox: the team's ${NAMES[provider]} key was connected`);
  sendLimits(hub);
  return test(hub, provider);
}

/** A connected provider's limit. */
export function setLimit(hub: Hub, input: { provider: string; limit: number }): SandboxState {
  const provider = known(input.provider);
  const limit = limitOf(input.limit);
  if (!rowOf(hub, provider)) throw new ToolError("invalid", `No ${NAMES[provider]} key is connected.`, "connect one first (sandbox_connect)");
  hub.db.conn.query("UPDATE sandbox_providers SET max_agents = ?1 WHERE provider = ?2").run(limit, provider);
  sendLimits(hub);
  return state(hub);
}

/** Removes the provider's key, domain and limit. */
export function disconnect(hub: Hub, input: { provider: string }): SandboxState {
  const provider = known(input.provider);
  hub.db.conn.query("DELETE FROM sandbox_providers WHERE provider = ?1").run(provider);
  console.info(`sandbox: the team's ${NAMES[provider]} key was removed`);
  sendLimits(hub);
  return state(hub);
}

/** The provider's key, opened for `why` (logged, never the key); undefined while none is connected. */
async function keyOf(hub: Hub, provider: KnownSandboxProvider, why: string): Promise<string | undefined> {
  const boxed = rowOf(hub, provider)?.sealed;
  if (!boxed) return undefined;
  const v = vault(hub);
  await v.load();
  const id = keyIdOf(boxed);
  const root = id === undefined ? undefined : v.keys.key(id);
  const plain = root ? openItem(root, binding(provider), boxed) : null;
  if (!plain) {
    throw new ToolError(
      "failed",
      `The team's ${NAMES[provider]} key didn't open with the vault's key.`,
      "unlock the vault in Settings › Vault; if it still fails, an admin connects the key again in Settings › Hub › Machines",
    );
  }
  console.info(`sandbox: the team's ${NAMES[provider]} key was used: ${why}`);
  return Buffer.from(plain).toString("utf8");
}

/** `{"provider","key","domain"?}` sealed to `machineId`'s box key (base64), for a node that creates sandboxes there. */
export async function sealedTo(hub: Hub, machineId: string, provider: KnownSandboxProvider, why: string): Promise<string> {
  const to = store(hub).machineGet(machineId)?.boxPubKey;
  if (!to) throw new ToolError("failed", `${machineId} gave the hub no key to seal the team's ${NAMES[provider]} key to.`, "try again once its node links again");
  const key = await keyOf(hub, provider, `${why} on ${machineId}`);
  if (key === undefined) throw new ToolError("failed", `No ${NAMES[provider]} key is connected.`, "an admin connects one in Settings › Hub › Machines");
  const domain = rowOf(hub, provider)?.domain;
  return b64(seal(Buffer.from(to, "base64"), new TextEncoder().encode(JSON.stringify({ provider, key, ...(domain ? { domain } : {}) }))));
}

/** How long the hub waits for a machine's check: the check's own wait and a grace. */
export const CHECK_REPLY_SEC = CHECK_WAIT / 1000 + 15;

/**
 * Checks the provider's key where agents' sandboxes are made: on the team's machines online that make them
 * (CAP_SANDBOX), in the order of their ids, the first that answers asks the provider for fleetd's sandboxes there,
 * which starts nothing. The hub's own process never calls a provider.
 */
export async function test(hub: Hub, providerIn: string): Promise<SandboxState> {
  const provider = known(providerIn);
  if (!rowOf(hub, provider)) throw new ToolError("invalid", `No ${NAMES[provider]} key is connected.`, "connect one first");
  const at = isoMs(hub.clock.now());
  const machines = store(hub)
    .machinesList()
    .filter((m) => link(hub).can(m.machineId, CAP_SANDBOX));
  const unanswered: string[] = [];
  let check: SandboxCheck | undefined;
  for (const m of machines) {
    let reply: NodeActionResult;
    try {
      const sealed = await sealedTo(hub, m.machineId, provider, "a check");
      reply = (await link(hub).request(m.machineId, { t: "node_action", id: "", action: "sandbox_check", sandbox: sealed }, { waitSec: CHECK_REPLY_SEC })) as unknown as NodeActionResult;
    } catch (e) {
      unanswered.push(`${m.name} (${(e as Error).message})`);
      continue;
    }
    if (reply.ok) {
      check = { at, ok: true };
      break;
    }
    const reason = reasonOf(reply.reason);
    check = { at, ok: false, reason, message: `${m.name}: ${reply.message}`, fix: checkFix(provider, reason, m.name) };
    break;
  }
  check ??= {
    at,
    ok: false,
    reason: "failed",
    message:
      machines.length === 0
        ? "No Linux machine of the team's is online to test the key: sandboxes are made there."
        : `No machine of the team's could test the key. No check from ${unanswered.join(", ")}.`,
    fix: "bring one of the team's Linux machines online with an up-to-date fleetd, then test again",
  };
  hub.db.conn.query("UPDATE sandbox_providers SET check_json = ?1 WHERE provider = ?2").run(JSON.stringify(check), provider);
  return state(hub);
}

/** The connected providers' limits to the slot board, and with their keys (each sealed to the machine's own box key)
 * to `machineIds` (every machine that makes sandboxes, by default). */
export function sendLimits(hub: Hub, machineIds?: string[]): void {
  const all = limits(hub);
  try {
    slots(hub).setHosted(all);
  } catch (e) {
    console.warn(`sandbox: limits not given to the slot board: ${(e as Error).message}`);
  }
  const to = machineIds ?? store(hub).machinesList().map((m) => m.machineId);
  for (const m of to) {
    if (!link(hub).can(m, CAP_SANDBOX)) continue;
    void (async () => {
      const keys: Record<string, string> = {};
      for (const l of all) keys[l.provider] = await sealedTo(hub, m, l.provider, "making agents' boxes");
      await link(hub).request(m, { t: "node_action", id: "", action: "sandbox_limits", limits: all, keys }, { waitSec: 15 });
    })().catch((e: unknown) => console.warn(`sandbox: limits not sent to ${m}: ${(e as Error).message}`));
  }
}

/** For hub/doctor: each connected provider's name and last check, in the order agents go to them. */
export function checks(hub: Hub): [name: string, check?: SandboxCheck][] {
  const all = rows(hub);
  return ORDER.flatMap((p) => {
    const r = all.find((x) => x.provider === p);
    return r ? [[NAMES[p], checkOf(r)] as [string, SandboxCheck | undefined]] : [];
  });
}
