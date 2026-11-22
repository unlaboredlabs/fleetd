// An MCP server's vault values on its machines: the hub opens each item, seals its value to every machine that runs
// the server (a bot's machine, or for the team's every machine it knows a box key of) and hands it to that node's
// `mcp_secrets`, keeping the server's other secrets there. It runs after each save and each minute, so a changed item,
// a machine that was offline, or a deleted item (taken back, with the problem on the row) reach the nodes without a
// save. Each sealing is a vault_audit row; the value is never logged or kept.
import type { McpSealedOn, McpServer, McpValue } from "../../shared/contracts.ts";
import { seal } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { linked, nodeCan, sessionCall } from "../link/node_port.ts";
import { store } from "../store/hub_store.ts";
import { fingerprintOf } from "../vault/fields.ts";
import { vault } from "../vault/index.ts";
import { type McpField, mcpServers, secretScope, valuesOf } from "./index.ts";
import { CAP_MCP_SERVERS } from "./rules.ts";
import { keptVaultValue, vaultAudit, vaultProblem, vaultSetOf, vaultValue } from "./vault_values.ts";

/** Each machine's box key, by id, of the machines a server runs on. */
function machinesOf(hub: Hub, s: McpServer): [string, Uint8Array][] {
  const all = store(hub).machinesList();
  const ids = s.scope.kind === "project" ? [s.scope.machineId] : all.map((m) => m.machineId);
  return ids.flatMap((m): [string, Uint8Array][] => {
    const k = all.find((x) => x.machineId === m)?.boxPubKey;
    return k ? [[m, new Uint8Array(Buffer.from(k, "base64"))]] : [];
  });
}

type Want = { field: McpField; v: McpValue; value: string | undefined; problem: string | undefined; fp: string | undefined };

/** Brings `s`'s vault values up to date on every machine that runs it; the row as saved after. */
export async function syncVault(hub: Hub, s: McpServer): Promise<McpServer> {
  const vaulted = valuesOf(s).filter(([, v]) => v.kind === "vault");
  if (vaulted.length === 0) return s;
  const v = vault(hub);
  const wants: Want[] = vaulted.map(([field, val]) => {
    const item = val.itemId ? v.store.get(val.itemId) : undefined;
    let problem = vaultProblem(s.scope, item, val.field);
    let value: string | undefined;
    if (problem === undefined && item) {
      try {
        value = vaultValue(item.kind, v.store.open(item), val.field, val.prefix);
        if (value === undefined) problem = `${item.label} has no ${item.kind === "env" ? "value" : "password"}.`;
      } catch (e) {
        // A locked vault or a lost key: the machines keep what they hold until it opens again.
        return { field, v: val, value: undefined, problem: undefined, fp: undefined };
      }
    }
    return { field, v: val, value, problem, fp: value === undefined ? undefined : fingerprintOf(value) };
  });
  const held = new Map<string, McpSealedOn[]>(wants.map((w) => [`${w.field}\u0000${w.v.name}`, [...(w.v.sealedOn ?? [])]]));
  let changed = false;
  for (const [m, box] of machinesOf(hub, s)) {
    if (!linked(hub, m) || !nodeCan(hub, m, CAP_MCP_SERVERS)) continue;
    const on = (w: Want) => (w.v.sealedOn ?? []).find((x) => x.machineId === m);
    // Sealed again: a value the machine doesn't hold as it is now. Taken back: one with a problem it still holds.
    const send = wants.filter((w) => w.value !== undefined && on(w)?.fingerprint !== w.fp);
    const drop = wants.filter((w) => w.problem !== undefined && on(w) !== undefined);
    if (send.length === 0 && drop.length === 0) continue;
    const resent = new Set([...send, ...drop].map((w) => `${w.field}\u0000${w.v.name}`));
    const keep = valuesOf(s)
      .filter(([f, x]) => x.kind !== "plain" && !resent.has(`${f}\u0000${x.name}`) && (x.sealedOn ?? []).some((y) => y.machineId === m))
      .map(([field, x]) => ({ field, name: x.name }));
    const set = send.map((w) => ({ field: w.field, name: w.v.name, sealed: Buffer.from(seal(box, Buffer.from(w.value!, "utf8"))).toString("base64") }));
    const atMs = hub.clock.now();
    try {
      const out = await sessionCall(hub, m, { op: "mcp_secrets", scope: secretScope(s.scope), server: s.name, set, keep });
      const prints = (out.secrets as { field: McpField; name: string; fingerprint: string }[] | undefined) ?? [];
      for (const w of [...send, ...drop]) {
        const key = `${w.field}\u0000${w.v.name}`;
        const fp = prints.find((p) => p.field === w.field && p.name === w.v.name)?.fingerprint;
        const rest = (held.get(key) ?? []).filter((x) => x.machineId !== m);
        held.set(key, fp === undefined ? rest : [...rest, { machineId: m, fingerprint: fp }].sort((a, b) => (a.machineId < b.machineId ? -1 : 1)));
      }
      for (const w of send) v.used(vaultAudit(v.store.get(w.v.itemId!)!, m, s.scope, s.name, atMs));
      changed = true;
    } catch (e) {
      console.warn(`MCP vault values of ${s.name} not sealed on ${m}:`, (e as Error).message);
      for (const w of send) v.used(vaultAudit(v.store.get(w.v.itemId!)!, m, s.scope, s.name, atMs, (e as Error).message.slice(0, 300)));
    }
  }
  const kept = (field: McpField, list: McpValue[] | undefined) =>
    (list ?? []).map((x) => {
      if (x.kind !== "vault") return x;
      const w = wants.find((y) => y.field === field && y.v.name === x.name)!;
      const item = x.itemId ? v.store.get(x.itemId) : undefined;
      return keptVaultValue(vaultSetOf(x), item, held.get(`${field}\u0000${x.name}`) ?? [], w.problem);
    });
  const next: McpServer = { ...s, env: kept("env", s.env), headers: kept("header", s.headers) };
  if (!changed && JSON.stringify(next) === JSON.stringify(s)) return s;
  // Saved over the row as it is now, so a renewal or a save while the nodes answered isn't undone.
  const now = mcpServers(hub).get(s.scope, s.name);
  if (now === undefined || now.updatedAt !== s.updatedAt) return now ?? s;
  mcpServers(hub).put(next);
  return next;
}

/** Every server's vault values, each minute. */
export async function syncAllVault(hub: Hub): Promise<void> {
  const s = mcpServers(hub);
  for (const server of [...s.list({ kind: "global" }), ...s.perBot()]) {
    try {
      await syncVault(hub, server);
    } catch (e) {
      console.warn(`MCP vault values of ${server.name} not synced:`, (e as Error).message);
    }
  }
}
