// The nodes' and agents' vault calls (vault-design §4): `vault_fill` and `vault_filled` from the node hosting a
// browser, `vault_items` for an agent to see what it may use, and the card a purchase claim carries. The hub decides
// who a fill is for from its own records (the browser session's project, task and host), never from the call; checks
// the item's scope, kind and site and the rate limits; writes the audit row; and only then opens the value, sealed to
// the hosting node's box key. An agent never sees a value: its tool gets a label back.
import type { ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { seal } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { approvals } from "../approvals/index.ts";
import { purchases } from "../approvals/purchases.ts";
import { get as browserSession } from "../browser/store.ts";
import { runsOn } from "../browser/live.ts";
import { chat } from "../chat/index.ts";
import { type LeadCall, type LeadCaller, leadCalls } from "../lead_calls/index.ts";
import { store as hubStore } from "../store/hub_store.ts";
import type { AuditData } from "./audit.ts";
import { envRows } from "./deliver.ts";
import { FIELDS, hostOf, type Secret, totpCode, type VaultKind } from "./fields.ts";
import { FILLS_PER_HOST_HOUR, FILLS_PER_ITEM_HOUR, onAny, onSite, resolve } from "./fill.ts";
import { type ItemRow, type UseContext, vault } from "./index.ts";

export { FILLS_PER_HOST_HOUR, FILLS_PER_ITEM_HOUR, onSite, resolve, SHARED_HOSTING } from "./fill.ts";

export const OPS = ["vault_fill", "vault_filled", "vault_items"] as const;

/** Refusals of one session within ten minutes that put a line in the project's chat. */
const REFUSALS_LINE = 3;
/** A purchase's window: an address fills at its shop within it. */
const PURCHASE_WINDOW_MS = 15 * 60_000;

/** The page's host, lowercase; refused for anything but https (http only for localhost-free private tests: never). */
function pageHost(url: unknown, what: string): string {
  if (typeof url !== "string") throw new ToolError("invalid", `${what}: expected the page's address`);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ToolError("invalid", `${what} isn't an address`);
  }
  if (u.protocol !== "https:") throw new ToolError("forbidden", `${what} isn't https: fleetd fills only over https.`, "Open the site over https.");
  const host = hostOf(u.hostname);
  if (!host) throw new ToolError("forbidden", `${u.hostname} isn't a site fleetd fills on.`);
  return host;
}

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/** Who a browser session works for, from its own record, and the machine hosting it. */
export function sessionContext(hub: Hub, caller: LeadCaller, sessionId: unknown): { ctx: UseContext; host: string; sessionId: string } {
  if (typeof sessionId !== "string" || !/^B[0-9a-f]{32}$/.test(sessionId)) throw new ToolError("invalid", "sessionId: expected a browser session id");
  const s = browserSession(hub, sessionId);
  if (!s || !sameProject(s.projectRef, caller.projectRef)) {
    throw new ToolError("not_found", `No browser session ${sessionId} of this project.`, "Fill only in a session this agent opened.");
  }
  if (s.state !== "live") throw new ToolError("forbidden", `The browser session ${sessionId} has ended.`, "Open a new one.");
  const host = runsOn(hub, s);
  if (caller.via !== undefined && caller.via !== host) {
    throw new ToolError("forbidden", "Only the machine hosting a browser session fills in it.", "Fill from the session's own node.");
  }
  const v = vault(hub);
  const { personId, workstreamId } = v.personFor(s.projectRef, s.taskId);
  return {
    ctx: {
      projectRef: s.projectRef,
      ...(s.taskId !== undefined ? { taskId: s.taskId } : {}),
      ...(workstreamId !== undefined ? { workstreamId } : {}),
      ...(personId !== undefined ? { personId } : {}),
      threadId: s.threadId,
    },
    host,
    sessionId,
  };
}


/** The address fill's own sites: a checkout recorded in the session, the item's sites, the team vault's logins' sites. */
function addressAllowed(hub: Hub, row: ItemRow, host: string, sessionId: string, ctx: UseContext): boolean {
  if (onAny(host, row.meta.sites)) return true;
  const now = hub.clock.now();
  for (const q of purchases(approvals(hub), ctx.projectRef, 50)) {
    const p = q.purchase;
    const at = Date.parse(q.createdAt);
    if (p?.sessionId === sessionId && now - at <= PURCHASE_WINDOW_MS && onSite(host, p.shop.domain)) return true;
  }
  return vault(hub)
    .usable()
    .some((l) => l.kind === "login" && onAny(host, l.meta.sites));
}

const refuse = (message: string, fix: string) => new ToolError("forbidden", message, fix);

export class Fills {
  constructor(private readonly hub: Hub) {}

  /** `vault_fill`: the value for one field, sealed to the node hosting the browser. */
  fill(caller: LeadCaller, call: LeadCall): Record<string, unknown> {
    const hub = this.hub;
    const v = vault(hub);
    const { ctx, host, sessionId } = sessionContext(hub, caller, call.sessionId);
    const field = String(call.field ?? "");
    if (!["username", "password", "otp", "address"].includes(field)) throw new ToolError("invalid", "field: username, password, otp or address");
    const site = pageHost(call.page, "page");
    const frame = call.frame !== undefined && call.frame !== null ? pageHost(call.frame, "frame") : undefined;
    const base: AuditData = { fields: [field], site, ...(frame !== undefined ? { frame } : {}), host, sessionId };
    const audit = (itemId: string, row: ItemRow | undefined, action: "fill" | "fill_refused", outcome: "pending" | "refused", extra: AuditData = {}) =>
      v.used({
        atMs: hub.clock.now(),
        itemId,
        action,
        outcome,
        ...(ctx.personId !== undefined ? { personId: ctx.personId } : {}),
        machineId: ctx.projectRef.machineId,
        projectId: ctx.projectRef.projectId,
        ...(ctx.threadId !== undefined ? { threadId: ctx.threadId } : {}),
        ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
        ...(ctx.workstreamId !== undefined ? { workstreamId: ctx.workstreamId } : {}),
        data: { ...base, ...(row ? { label: row.label, kind: row.kind } : {}), ...extra },
      });
    let row: ItemRow | undefined;
    try {
      v.requireOpen();
      row = resolve(v.usable(), call.item, call.ref);
      this.check(row, field, site, frame, sessionId, ctx, host);
    } catch (e) {
      if (e instanceof ToolError && (e.code === "forbidden" || e.code === "not_found" || e.reason === "vault_rate_limited")) {
        audit(row?.itemId ?? "", row, "fill_refused", "refused", { message: e.message.slice(0, 300) });
        this.refusalLine(ctx.projectRef, sessionId, row?.label, site);
      }
      throw e;
    }
    const auditId = audit(row.itemId, row, "fill", "pending");
    const secret = v.store.open(row);
    const plain = this.plain(row, field, secret);
    const box = hubStore(hub).machineGet(host)?.boxPubKey;
    if (!box) {
      v.audit.settle(auditId, "failed", { message: `${host} publishes no box key` });
      throw new ToolError("failed", `${host}'s node takes no sealed values.`, `Update fleetd on ${host}.`);
    }
    const bytes = Buffer.from(JSON.stringify(plain), "utf8");
    try {
      const sealed = Buffer.from(seal(new Uint8Array(Buffer.from(box, "base64")), bytes)).toString("base64");
      return { itemId: row.itemId, label: row.label, auditId, sealed };
    } finally {
      bytes.fill(0);
    }
  }

  private check(row: ItemRow, field: string, site: string, frame: string | undefined, sessionId: string, ctx: UseContext, host: string): void {
    const hub = this.hub;
    const v = vault(hub);
    if (row.kind === "card") throw refuse(`${row.label} is a card: cards fill only into a recorded purchase.`, "Use purchase_request, then purchase_fill.");
    if (field === "address") {
      if (row.kind !== "address") throw refuse(`${row.label} isn't an address.`, "Name an address item from vault_items.");
      for (const h of [site, ...(frame !== undefined ? [frame] : [])]) {
        if (!addressAllowed(hub, row, h, sessionId, ctx)) {
          throw refuse(
            `${row.label} doesn't fill on ${h}: an address fills at a checkout recorded in this session, on its own sites, or on a site the team vault has a login for.`,
            "Record the purchase first with purchase_request, or ask the person to add the site to the address.",
          );
        }
      }
    } else {
      if (row.kind !== "login") throw refuse(`${row.label} isn't a login.`, "Name a login from vault_items.");
      const name = field === "otp" ? "totp" : field;
      if (!row.meta.fields?.includes(name as never)) throw refuse(`${row.label} has no ${field}.`, "Ask the person to add it in the vault.");
      for (const h of [site, ...(frame !== undefined ? [frame] : [])]) {
        if (!onAny(h, row.meta.sites)) {
          throw refuse(
            `${row.label} is for ${(row.meta.sites ?? []).join(", ") || "no site"}, not ${h}.`,
            "Fill it only on its own site; check the address bar for a look-alike.",
          );
        }
      }
    }
    const now = hub.clock.now();
    if (v.audit.fillsForItem(row.itemId, ctx.projectRef.machineId, ctx.projectRef.projectId, now) >= FILLS_PER_ITEM_HOUR) {
      throw new ToolError("failed", `${row.label} filled ${FILLS_PER_ITEM_HOUR} times this hour.`, "Wait, then try again; say so in your result.", "vault_rate_limited");
    }
    if (v.audit.fillsOnHost(host, now) >= FILLS_PER_HOST_HOUR) {
      throw new ToolError("failed", `${host} filled ${FILLS_PER_HOST_HOUR} values this hour.`, "Wait, then try again.", "vault_rate_limited");
    }
  }

  /** What the node gets: one field's value (a fresh one-time code for `otp`), or the address fields; and the sites. */
  private plain(row: ItemRow, field: string, secret: Secret): Record<string, unknown> {
    if (field === "address") {
      const out: Record<string, unknown> = {};
      for (const f of FIELDS.address) if (secret[f] !== undefined) out[f] = secret[f];
      return { ...out, sites: row.meta.sites ?? [] };
    }
    const value = field === "otp" ? totpCode(secret.totp ?? "", this.hub.clock.now()) : (secret[field] ?? "");
    return { value, sites: row.meta.sites ?? [] };
  }

  /** The third refusal of one session within ten minutes: one quiet line in the project's chat, not an ask. */
  private refusalLine(r: ProjectRef, sessionId: string, label: string | undefined, site: string): void {
    const v = vault(this.hub);
    if (v.audit.refusalsIn(sessionId, this.hub.clock.now()) !== REFUSALS_LINE) return;
    try {
      chat(this.hub).systemLine(r, `An agent tried to fill ${label ?? "a vault item"} on ${site}; refused`);
    } catch (e) {
      console.warn("vault: the refusal line wasn't posted:", e);
    }
  }

  /** `vault_filled`: the fill's outcome, once, from the node it was sealed to. */
  filled(caller: LeadCaller, call: LeadCall): Record<string, unknown> {
    const v = vault(this.hub);
    const n = Number(call.auditId);
    const entry = Number.isInteger(n) ? v.audit.get(n) : undefined;
    const r = caller.projectRef;
    if (!entry || entry.machineId !== r.machineId || entry.projectId !== r.projectId || (entry.action !== "fill" && entry.action !== "purchase")) {
      throw new ToolError("not_found", `No fill ${String(call.auditId)} of this project.`);
    }
    if (caller.via !== undefined && entry.data.host !== caller.via) throw new ToolError("forbidden", "Only the machine that filled reports the fill.");
    const ok = call.ok === true;
    const message = typeof call.message === "string" ? call.message.slice(0, 300) : undefined;
    if (v.audit.settle(n, ok ? "ok" : "failed", { typed: call.typed === true, ...(message !== undefined ? { message } : {}) })) {
      v.usedEvent(n, { ...entry, outcome: ok ? "ok" : "failed" });
    }
    return { auditId: n };
  }

  /**
   * `vault_items`: the team vault's logins, cards and addresses (labels, sites and fields) and the variables in the
   * session's environment, by name. Never a value.
   */
  items(caller: LeadCaller, call: LeadCall): Record<string, unknown> {
    const v = vault(this.hub);
    const agent = caller.agent;
    const taskId = agent.kind === "task" ? agent.taskId : undefined;
    const workstreamId = taskId !== undefined ? v.orderOfTask(taskId) : undefined;
    const kind = typeof call.kind === "string" ? (call.kind as VaultKind) : undefined;
    const site = typeof call.site === "string" ? hostOf(call.site) : undefined;
    const items: Record<string, unknown>[] = [];
    if (kind === undefined || kind !== "env") {
      for (const row of v.usable()) {
        if (kind !== undefined && row.kind !== kind) continue;
        if (site !== undefined && row.kind === "login" && !onAny(site, row.meta.sites)) continue;
        if (site !== undefined && row.kind !== "login") continue;
        items.push({
          itemId: row.itemId,
          kind: row.kind,
          label: row.label,
          ...(row.kind === "login" ? { sites: row.meta.sites ?? [], fields: row.meta.fields ?? [] } : {}),
          ...(row.kind === "address" && row.meta.sites?.length ? { sites: row.meta.sites } : {}),
        });
      }
    }
    if ((kind === undefined || kind === "env") && site === undefined) {
      for (const row of envRows(this.hub, caller.projectRef, workstreamId)) {
        items.push({ itemId: row.itemId, kind: "env", label: row.label, envName: row.envName });
      }
    }
    return { items };
  }
}

export const fills = (hub: Hub) => hub.area("vault.fills", (h) => new Fills(h));

export function registerLeadCalls(hub: Hub): void {
  const calls = leadCalls(hub);
  calls.register("vault_fill", (caller, call) => fills(hub).fill(caller, call));
  calls.register("vault_filled", (caller, call) => fills(hub).filled(caller, call));
  calls.register("vault_items", (caller, call) => fills(hub).items(caller, call));
}
