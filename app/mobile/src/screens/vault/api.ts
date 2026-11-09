// The Vault's hub calls. A value only ever crosses as a sealed box: one the person typed is sealed here to the hub's box
// key (vault_status's hubBoxKey) before it leaves the phone, and one revealed comes back sealed to a key pair made for
// that one reveal, whose secret half is wiped as soon as it's opened (vault-design §4.6). Nothing here keeps a value or
// logs one: the caller gets the opened fields, shows them, and lets them go.
import { getRandomBytes } from "expo-crypto";
import type { HubError, ProjectRef } from "../../desktop";
import type { Session } from "../../session";
import { fromBase64, keyPairOf, openSealed, seal, toBase64, utf8, utf8Encode } from "../../seal";
import type { Result } from "../manage/api";
import type { VaultAuditEntry, VaultImportHit, VaultItemSummary, VaultKind, VaultScope, VaultStatus } from "./types";

/** The calls these make, typed loosely: the vault's tools are read by their own shapes (types.ts). */
export interface VaultHub {
  call(tool: string, input: unknown, timeoutMs?: number): Promise<{ readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: HubError }>;
}

export const vaultHub = (session: Pick<Session, "call">): VaultHub => ({
  call: (tool, input, timeoutMs) => session.call(tool as never, input as never, timeoutMs) as never,
});

/** Searching 1Password and reading items from it may install its SDK on a machine first. */
export const ONEPASSWORD_MS = 240_000;

const cleanRef = (p: ProjectRef): ProjectRef => ({ machineId: p.machineId, projectId: p.projectId });

const failed = (message: string): { ok: false; error: HubError } => ({ ok: false, error: { code: "failed", message } });

/** Whose items a list shows: the person's own and the hub's (Settings › Vault), or one project's (its Info › Vault). */
export type Whose = { readonly kind: "mine" } | { readonly kind: "project"; readonly project: ProjectRef };

/**
 * A project's list is what its work can use that the person can see; its Vault shows its own items (and its orders'
 * variables) among them, the person's shared ones and the hub's staying in Settings.
 */
export const listItems = async (hub: VaultHub, whose: Whose): Promise<Result<readonly VaultItemSummary[]>> => {
  const r = await hub.call("vault_list", whose.kind === "mine" ? {} : cleanRef(whose.project));
  if (!r.ok) return r;
  const items = (r.output as { items: readonly VaultItemSummary[] }).items;
  return { ok: true, value: whose.kind === "mine" ? items : items.filter((i) => i.scope === "project" || i.scope === "order") };
};

/** The cards a project's work can pay with: its own, the person's it may use, and the hub's. */
export const usableCards = async (hub: VaultHub, p: ProjectRef): Promise<Result<readonly VaultItemSummary[]>> => {
  const r = await hub.call("vault_list", { kind: "card", ...cleanRef(p) });
  return r.ok ? { ok: true, value: (r.output as { items: readonly VaultItemSummary[] }).items.filter((i) => i.kind === "card" && i.deletedMs === undefined) } : r;
};

export const readItem = async (hub: VaultHub, itemId: string): Promise<Result<{ item: VaultItemSummary; activity: readonly VaultAuditEntry[] }>> => {
  const r = await hub.call("vault_get", { itemId });
  return r.ok ? { ok: true, value: r.output as { item: VaultItemSummary; activity: readonly VaultAuditEntry[] } } : r;
};

export const readStatus = async (hub: VaultHub): Promise<Result<VaultStatus>> => {
  const r = await hub.call("vault_status", {});
  return r.ok ? { ok: true, value: r.output as VaultStatus } : r;
};

/** `value` as JSON sealed to the hub's box key, base64; the plaintext bytes and the one-time key wiped after. */
export const sealToHub = (value: unknown, hubBoxKey: string): string | null => {
  const recipient = fromBase64(hubBoxKey);
  if (recipient?.length !== 32) return null;
  const plain = utf8Encode(JSON.stringify(value));
  const random = getRandomBytes(32);
  const ephemeral = keyPairOf(random);
  try {
    return toBase64(seal(plain, recipient, ephemeral));
  } finally {
    plain.fill(0);
    random.fill(0);
    ephemeral.secretKey.fill(0);
  }
};

export interface SaveItem {
  /** An item being changed; none for a new one. */
  readonly itemId?: string;
  readonly kind: VaultKind;
  readonly scope: VaultScope;
  readonly project?: ProjectRef;
  readonly label: string;
  readonly sites?: readonly string[];
  readonly envName?: string;
  /** A variable's: masked and revealed behind Face ID (true), or shown as it is. */
  readonly secret?: boolean;
  /** The fields typed: all of a new item's, only the changed ones of an edit (the hub merges them). None: label only. */
  readonly fields?: Readonly<Record<string, string>>;
}

/** A new item, or a change to one, its fields sealed to the hub on the way. */
export const saveItem = async (hub: VaultHub, s: SaveItem): Promise<Result<VaultItemSummary>> => {
  const typed = s.fields !== undefined && Object.keys(s.fields).length > 0;
  let sealed: string | undefined;
  if (typed) {
    const status = await readStatus(hub);
    if (!status.ok) return status;
    if (status.value.locked) return failed("The vault is locked. An owner unlocks it in the desktop app.");
    sealed = sealToHub(s.fields, status.value.hubBoxKey) ?? undefined;
    if (sealed === undefined) return failed("The hub's key didn't come through. Try again.");
  }
  const r = await hub.call("vault_save", {
    ...(s.itemId === undefined ? {} : { itemId: s.itemId }),
    kind: s.kind,
    scope: s.scope,
    ...(s.project === undefined ? {} : cleanRef(s.project)),
    label: s.label,
    ...(s.sites === undefined ? {} : { sites: s.sites }),
    ...(s.envName === undefined ? {} : { envName: s.envName }),
    ...(s.secret === undefined ? {} : { secret: s.secret }),
    ...(sealed === undefined ? {} : { sealed }),
  });
  return r.ok ? { ok: true, value: (r.output as { item: VaultItemSummary }).item } : r;
};

/** To the trash, kept 30 days; Restore brings it back. */
export const deleteItem = async (hub: VaultHub, itemId: string): Promise<Result<null>> => {
  const r = await hub.call("vault_delete", { itemId });
  return r.ok ? { ok: true, value: null } : r;
};

export const restoreItem = async (hub: VaultHub, itemId: string): Promise<Result<null>> => {
  const r = await hub.call("vault_restore", { itemId });
  return r.ok ? { ok: true, value: null } : r;
};

/**
 * Some of an item's fields, opened: the hub seals them to a key pair made here for this one reveal, and its secret half
 * is wiped as soon as they're out. The caller holds them only while they're shown.
 */
export const reveal = async (hub: VaultHub, itemId: string, fields: readonly string[]): Promise<Result<Record<string, string>>> => {
  const random = getRandomBytes(32);
  const keys = keyPairOf(random);
  try {
    const r = await hub.call("vault_reveal", { itemId, fields, replyKey: toBase64(keys.publicKey) });
    if (!r.ok) return r;
    const box = fromBase64((r.output as { sealed?: unknown }).sealed as string);
    const plain = box === null ? null : openSealed(box, keys);
    if (plain === null) return failed("The hub's answer didn't open on this phone.");
    const text = utf8(plain);
    plain.fill(0);
    const parsed: unknown = text === null ? null : JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return failed("The hub's answer didn't open on this phone.");
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return { ok: true, value: out };
  } catch {
    return failed("The hub's answer didn't open on this phone.");
  } finally {
    random.fill(0);
    keys.secretKey.fill(0);
  }
};

/** Items in the person's 1Password matching `query`, read on a machine holding their token: titles and sites, never values. */
export const searchOnePassword = async (hub: VaultHub, query: string): Promise<Result<readonly VaultImportHit[]>> => {
  const r = await hub.call("vault_import_search", { query }, ONEPASSWORD_MS);
  return r.ok ? { ok: true, value: (r.output as { items: readonly VaultImportHit[] }).items } : r;
};

export interface Imported {
  readonly items: readonly VaultItemSummary[];
  readonly errors: ReadonlyArray<{ ref: string; message: string }>;
}

/**
 * The ticked 1Password items brought into the vault: a machine holding the token reads them and seals them to the hub,
 * so their values never pass through the phone. From a lead's proposal (`proposalId`), or picked here.
 */
export const importItems = async (hub: VaultHub, i: { proposalId?: string; refs: readonly string[]; scope: VaultScope; project?: ProjectRef }): Promise<Result<Imported>> => {
  const r = await hub.call(
    "vault_import",
    { ...(i.proposalId === undefined ? {} : { proposalId: i.proposalId }), refs: i.refs, scope: i.scope, ...(i.project === undefined ? {} : cleanRef(i.project)) },
    ONEPASSWORD_MS,
  );
  return r.ok ? { ok: true, value: r.output as Imported } : r;
};

/** A lead's proposal turned down: its card says so, and nothing is read from 1Password. */
export const dismissImport = async (hub: VaultHub, proposalId: string): Promise<Result<null>> => {
  const r = await hub.call("vault_import", { proposalId, dismiss: true });
  return r.ok ? { ok: true, value: null } : r;
};

/** Whether a hub event changes what a vault screen shows: an item changed, or used (its activity). */
export const touchesVault = (event: { readonly type: string }): boolean => event.type === "vault.changed" || event.type === "vault.used";

/** The hub's reasons a vault call failed, in the person's words. */
export const vaultErrorWords = (e: HubError): string | undefined => {
  const reason = e.reason;
  if (reason === "vault_locked") return "The vault is locked. An owner unlocks it in the desktop app, under Settings › You › Vault.";
  if (reason === "vault_rate_limited") return "Too many reveals in the last hour. Try again later.";
  if (reason === "vault_key_missing") return "The vault's key is missing on the hub. An owner restores it with the recovery code.";
  return undefined;
};
