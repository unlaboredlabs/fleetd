// 1Password as an optional source (vault-design §6): never the day-to-day path. A lead searches the person's
// 1Password (titles, kinds and sites, never values) and proposes items; the import card in the chat is the one confirm
// in the vault. On Import, a node holding the person's token reads the items and seals their fields to the hub's box
// key, so no value crosses the hub in the clear or reaches the agent; the hub stores each with its `op://` reference
// as the source and never asks 1Password for it again.
import { randomBytes } from "node:crypto";
import type { ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_VAULT } from "../../shared/node_link.ts";
import { publicKeyOf } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { leadWakes } from "../api/leads.ts";
import { allows } from "../auth/index.ts";
import { mayUse } from "../navi/owner.ts";
import { chat } from "../chat/index.ts";
import { linked, nodeCan, sessionCall } from "../cloud/node.ts";
import { boxKey } from "../hub_links/store.ts";
import { type LeadCall, type LeadCaller, leadCalls } from "../lead_calls/index.ts";
import { forLead, token } from "../onepassword/index.ts";
import { ClaudeAccountStore, whoseForLead } from "../claude_accounts/index.ts";
import { cleanSites, FIELDS, hostOf, type VaultKind, type VaultScope } from "./fields.ts";
import { isScope, vault, type Viewer } from "./index.ts";
import { openToHub, saveItem, summary } from "./items.ts";

export type Candidate = { ref: string; title: string; kind: VaultKind; vault: string; sites?: string[]; imported?: string };
type CardItem = { ref: string; title: string; kind: VaultKind; site?: string };
type Card = { proposalId: string; why: string; scope: VaultScope; items: CardItem[]; state: "open" | "imported" | "dismissed"; imported?: number; answeredMs?: number };

const OP_ITEM = /^op:\/\/[^/?\r\n]+\/[^/?\r\n]+$/;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** A machine online and new enough that holds `person`'s 1Password token; `want` first when given. */
function holder(hub: Hub, person: string, want?: string): string | undefined {
  const held = token(hub.db, person)?.sealedOn.map((s) => s.machineId) ?? [];
  const ready = (m: string) => linked(hub, m) && nodeCan(hub, m, CAP_VAULT);
  if (want !== undefined) return held.includes(want) && ready(want) ? want : undefined;
  return held.find(ready);
}

const noToken = (hub: Hub, person: string) =>
  token(hub.db, person) === undefined
    ? "No 1Password token is saved: add one in Settings › You › Your accounts › 1Password to import from it."
    : "No machine holding the 1Password token is online with a node new enough to read it.";

/** The items already imported from each `op://` reference, among those `person` sees. */
function importedRefs(hub: Hub): Map<string, string> {
  const rows = vault(hub).store.select("json_extract(meta, '$.source.kind') = '1password'", []);
  return new Map(rows.map((r) => [r.meta.source?.kind === "1password" ? r.meta.source.ref : "", r.itemId]));
}

/** Searches the person's 1Password; metadata only. */
export async function search(hub: Hub, person: string, query: string, kinds?: VaultKind[], machineId?: string): Promise<{ items: Candidate[]; error?: string }> {
  const m = holder(hub, person, machineId);
  if (m === undefined) return { items: [], error: noToken(hub, person) };
  let out: Record<string, unknown>;
  try {
    out = await sessionCall(hub, m, { op: "vault_import_search", personId: person, query, ...(kinds ? { kinds } : {}) });
  } catch (e) {
    return { items: [], error: `${m} couldn't search 1Password: ${(e as Error).message}` };
  }
  if (typeof out.error === "string") return { items: [], error: out.error };
  const done = importedRefs(hub);
  const items = (Array.isArray(out.items) ? (out.items as Candidate[]) : [])
    .filter((c) => typeof c?.ref === "string" && OP_ITEM.test(c.ref) && (kinds === undefined || kinds.includes(c.kind)))
    .map((c) => ({
      ref: c.ref,
      title: String(c.title ?? "").slice(0, 200),
      kind: c.kind,
      vault: String(c.vault ?? ""),
      ...(Array.isArray(c.sites) ? { sites: c.sites.map(String).slice(0, 20) } : {}),
      ...(done.has(c.ref) ? { imported: done.get(c.ref)! } : {}),
    }));
  rememberCandidates(hub, person, items);
  return { items };
}

/** The last search's candidates per person, so a proposal shows titles without another search. */
const seen = (hub: Hub) => hub.area("vault.import.seen", () => new Map<string, Map<string, Candidate>>());
function rememberCandidates(hub: Hub, person: string, items: Candidate[]): void {
  const mine = seen(hub).get(person) ?? new Map<string, Candidate>();
  for (const c of items) mine.set(c.ref, c);
  while (mine.size > 500) mine.delete(mine.keys().next().value!);
  seen(hub).set(person, mine);
}

/** The person whose 1Password a lead imports from: a Navi's owner, else the hub's owner. */
function leadPerson(hub: Hub, r: ProjectRef): string | undefined {
  const owner = forLead(hub.db, r);
  if (owner !== undefined) return owner;
  try {
    const whose = whoseForLead(hub.db, new ClaudeAccountStore(hub.db).setup(), r);
    if ("person" in whose) return whose.person;
  } catch {}
  return (
    hub.db.conn.query<{ person_id: string }, []>("SELECT person_id FROM people WHERE role = 'owner' AND removed_ms IS NULL ORDER BY created_ms LIMIT 1").get()
      ?.person_id ?? undefined
  );
}

const leadOnly = (caller: LeadCaller) => {
  if (caller.agent.kind !== "lead") {
    throw new ToolError("forbidden", "Only a project's lead searches 1Password for imports.", "Ask your lead with ask_lead.");
  }
};

/** `vault_import_propose`: an import card in the chat; the person confirms with one tap. */
export async function propose(hub: Hub, caller: LeadCaller, call: LeadCall): Promise<Record<string, unknown>> {
  leadOnly(caller);
  const r = caller.projectRef;
  const person = leadPerson(hub, r);
  if (person === undefined) throw new ToolError("failed", "Nobody's 1Password to import from on this hub.");
  const refs = Array.isArray(call.refs) ? [...new Set(call.refs.map(String))] : [];
  if (refs.length === 0 || refs.length > 50 || refs.some((x) => !OP_ITEM.test(x))) {
    throw new ToolError("invalid", "refs: 1 to 50 op://<vault>/<item> references from vault_import_search.");
  }
  const why = typeof call.why === "string" ? call.why.trim().slice(0, 500) : "";
  if (why === "") throw new ToolError("invalid", "why: say in a line why these items are needed.");
  const scope: VaultScope = isScope(call.scope) && call.scope !== "order" ? call.scope : "person";
  let known = seen(hub).get(person);
  if (!known || refs.some((x) => !known!.has(x))) {
    await search(hub, person, "");
    known = seen(hub).get(person);
  }
  const items: CardItem[] = refs.map((ref) => {
    const c = known?.get(ref);
    if (!c) throw new ToolError("not_found", `${ref} isn't in the person's 1Password.`, "Use a ref vault_import_search returned.");
    return { ref, title: c.title, kind: c.kind, ...(c.sites?.[0] ? { site: c.sites[0] } : {}) };
  });
  const proposalId = `VP${randomBytes(16).toString("hex")}`;
  const card: Card = { proposalId, why, scope, items, state: "open" };
  const now = hub.clock.now();
  const message = chat(hub).add(r, { author: "lead", text: `Import ${items.length === 1 ? items[0]!.title : `${items.length} items`} from 1Password?`, vaultImport: card as never, source: `vault_import:${proposalId}` }).message;
  hub.db.conn
    .query(
      `INSERT INTO vault_imports (proposal_id, machine_id, project_id, person_id, thread_id, state, data, created_ms)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .run(proposalId, r.machineId, r.projectId, person, caller.threadId ?? null, JSON.stringify({ ...card, messageId: message.messageId }), now);
  return { proposalId, next: "The person imports or dismisses it in the chat; you're woken when they answer." };
}

type ImportInput = { proposalId?: string; refs?: string[]; scope?: VaultScope; machineId?: string; projectId?: string; dismiss?: boolean };

/** `vault_import`: a proposal's items (or the person's own pick) read from 1Password into the vault. */
export async function importItems(hub: Hub, v: Viewer, input: ImportInput): Promise<{ items: Record<string, unknown>[]; errors: { ref: string; message: string }[] }> {
  if (v.person === undefined) throw new ToolError("forbidden", "Only a person imports from their 1Password.");
  const vt = vault(hub);
  let proposal: { row: { machine_id: string; project_id: string; state: string }; card: Card & { messageId?: string } } | undefined;
  if (input.proposalId !== undefined) {
    const row = hub.db.conn
      .query<{ machine_id: string; project_id: string; state: string; data: string }, [string]>(
        "SELECT machine_id, project_id, state, data FROM vault_imports WHERE proposal_id = ?",
      )
      .get(input.proposalId);
    const r = row ? { machineId: row.machine_id, projectId: row.project_id } : undefined;
    if (!row || !r || !allows(v.caller, "operate", r.machineId) || !mayUse(hub.db, v.caller, r)) {
      throw new ToolError("not_found", `No import ${input.proposalId}.`);
    }
    if (row.state !== "open") throw new ToolError("invalid", `That import is ${row.state} already.`);
    proposal = { row, card: JSON.parse(row.data) };
  }
  const settle = (state: "imported" | "dismissed", imported?: number) => {
    if (!proposal) return;
    const now = hub.clock.now();
    const card: Card = { ...proposal.card, state, answeredMs: now, ...(imported !== undefined ? { imported } : {}) };
    hub.db.conn
      .query("UPDATE vault_imports SET state = ?, data = ?, answered_ms = ? WHERE proposal_id = ? AND state = 'open'")
      .run(state, JSON.stringify({ ...card, messageId: proposal.card.messageId }), now, card.proposalId);
    const message = proposal.card.messageId ? chat(hub).byId(proposal.card.messageId) : undefined;
    const { messageId: _, ...shown } = card as Card & { messageId?: string };
    if (message) chat(hub).setVaultImport(message, shown as never);
    const r = { machineId: proposal.row.machine_id, projectId: proposal.row.project_id };
    const what = state === "dismissed" ? "dismissed the import" : `imported ${imported ?? 0} of ${proposal.card.items.length} items into the vault`;
    leadWakes(hub).trigger(r, { kind: "line", line: "request", text: `The person ${what} (${card.proposalId}).` });
  };
  if (input.dismiss === true) {
    settle("dismissed");
    return { items: [], errors: [] };
  }
  const refs = input.refs ?? proposal?.card.items.map((i) => i.ref) ?? [];
  if (proposal && refs.some((x) => !proposal!.card.items.some((i) => i.ref === x))) {
    throw new ToolError("invalid", "Import only the items the card lists.");
  }
  const scope: VaultScope = input.scope ?? proposal?.card.scope ?? "person";
  const where =
    scope === "project"
      ? { machineId: input.machineId ?? proposal?.row.machine_id, projectId: input.projectId ?? proposal?.row.project_id }
      : {};
  const m = holder(hub, v.person);
  if (m === undefined) throw new ToolError("machine_offline", noToken(hub, v.person), "Try again once a machine holding your token is online.");
  const out = await sessionCall(hub, m, { op: "vault_import_read", personId: v.person, refs, to: b64(publicKeyOf(boxKey(hub))) });
  const errors: { ref: string; message: string }[] = Array.isArray(out.errors) ? (out.errors as { ref: string; message: string }[]).map((e) => ({ ref: String(e.ref), message: String(e.message).slice(0, 300) })) : [];
  const done = importedRefs(hub);
  const items: Record<string, unknown>[] = [];
  for (const read of Array.isArray(out.items) ? (out.items as { ref: string; kind: VaultKind; sealed: string }[]) : []) {
    if (!refs.includes(read.ref)) continue;
    try {
      const f = openToHub(hub, read.sealed) as { title?: string; sites?: string[]; login?: object; card?: object; address?: object };
      const kind: VaultKind = read.kind;
      const fields = kind === "login" ? f.login : kind === "card" ? f.card : kind === "address" ? f.address : undefined;
      if (!fields || !FIELDS[kind]) throw new ToolError("invalid", `a ${kind} can't be imported`);
      const sites = cleanSites((f.sites ?? []).map((s) => hostOf(String(s))).filter((s): s is string => s !== undefined));
      const existing = done.get(read.ref);
      const row = saveItem(
        hub,
        v,
        existing !== undefined && vt.store.get(existing)?.scope === scope && vt.canEdit(v, vt.store.get(existing)!)
          ? { itemId: existing, fields, sites, label: String(f.title ?? "Imported").slice(0, 120) }
          : {
              kind,
              scope,
              ...where,
              label: String(f.title ?? "Imported").slice(0, 120) || "Imported",
              sites,
              fields,
              source: { kind: "1password", ref: read.ref, importedMs: hub.clock.now() },
            },
        "import",
      );
      items.push(summary(hub, v, row));
    } catch (e) {
      errors.push({ ref: read.ref, message: e instanceof ToolError ? e.message : "it couldn't be stored" });
    }
  }
  settle("imported", items.length);
  return { items, errors };
}

export function registerLeadCalls(hub: Hub): void {
  const calls = leadCalls(hub);
  calls.register("vault_import_search", async (caller, call) => {
    leadOnly(caller);
    const person = leadPerson(hub, caller.projectRef);
    if (person === undefined) return { items: [], error: "Nobody's 1Password to search on this hub." };
    const kinds = Array.isArray(call.kinds) ? (call.kinds as VaultKind[]) : undefined;
    return await search(hub, person, typeof call.query === "string" ? call.query : "", kinds);
  });
  calls.register("vault_import_propose", (caller, call) => propose(hub, caller, call));
}
