// The Vault's hub calls. A value only ever crosses as a sealed box: one the person typed is sealed here to the hub's box
// key (vault_status's hubBoxKey) before it leaves the phone, and one revealed comes back sealed to a key pair made for
// that one reveal, whose secret half is wiped as soon as it's opened (vault-design §4.6). Nothing here keeps a value or
// logs one: the caller gets the opened fields, shows them, and lets them go.
import { getRandomBytes } from "expo-crypto";
import type { HubError, ProjectRef } from "../../desktop";
import type { Session } from "../../session";
import { fromBase64, keyPairOf, openSealed, seal, toBase64, utf8, utf8Encode } from "../../seal";
import type { Result } from "../manage/api";
import { knownKind } from "./model";
import type { VaultAuditEntry, VaultImportCandidate, VaultItemSummary, VaultKind, VaultStatus } from "./types";

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

/** Which list a screen shows: the team vault (Settings › Vault), or one project's variables (its Info › Vault). */
export type Whose = { readonly kind: "team" } | { readonly kind: "project"; readonly project: ProjectRef };

/** Only the kinds this app knows: one from a newer hub has no screen here. */
const known = <T extends { readonly kind: string }>(items: readonly T[]): Array<T & { kind: VaultKind }> => items.filter((i): i is T & { kind: VaultKind } => knownKind(i.kind));

/** A project's variable or one of its orders'. */
const projects = (i: Pick<VaultItemSummary, "scope">): boolean => i.scope === "project" || i.scope === "order";

export interface Listed {
  readonly items: readonly VaultItemSummary[];
  /** The person's own items from before the team vault, which nothing uses until they move them; none on an older hub. */
  readonly setAside: readonly VaultItemSummary[];
}

/**
 * The team's logins, cards and addresses, and the person's set-aside items (scope `person`) apart; or a project's
 * variables and its orders'. An older hub (no `vault_team`) has no set-aside: its `person` items are the person's own,
 * listed with the hub's as one list.
 */
export const listItems = async (hub: VaultHub, whose: Whose, team: boolean): Promise<Result<Listed>> => {
  const r = await hub.call("vault_list", whose.kind === "team" ? {} : cleanRef(whose.project));
  if (!r.ok) return r;
  const items = known((r.output as { items: readonly VaultItemSummary[] }).items);
  if (whose.kind === "project") return { ok: true, value: { items: items.filter(projects), setAside: [] } };
  const listed = items.filter((i) => !projects(i));
  return { ok: true, value: team ? { items: listed.filter((i) => i.scope !== "person"), setAside: listed.filter((i) => i.scope === "person") } : { items: listed, setAside: [] } };
};

/** The cards a project's work can pay with: the team's (and, on an older hub, the others it may use). */
export const usableCards = async (hub: VaultHub, p: ProjectRef): Promise<Result<readonly VaultItemSummary[]>> => {
  const r = await hub.call("vault_list", { kind: "card", ...cleanRef(p), usable: true });
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
  /** A new variable's project. A new login, card or address goes with no scope: to the team vault. */
  readonly project?: ProjectRef;
  readonly label: string;
  readonly sites?: readonly string[];
  readonly envName?: string;
  /** A variable's: masked and revealed behind Face ID (true), or shown as it is. */
  readonly secret?: boolean;
  /** The fields typed: all of a new item's, only the changed ones of an edit (the hub merges them). None: label only. */
  readonly fields?: Readonly<Record<string, string>>;
}

/**
 * A new item, or a change to one, its fields sealed to the hub on the way. Only a new variable names a scope (its
 * project's): a new login, card or address names none, which a newer hub takes as the team vault and an older one as
 * the person's own. A change names none either: the item stays where it is.
 */
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
    ...(s.itemId === undefined && s.kind === "env" && s.project !== undefined ? { scope: "project", ...cleanRef(s.project) } : {}),
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

/**
 * Items in the person's 1Password matching `query`, read on a machine holding their token: titles and sites, never
 * values. 1Password's own refusal (no token, a wrong one) comes back as the hub's error.
 */
export const searchOnePassword = async (hub: VaultHub, query: string): Promise<Result<readonly VaultImportCandidate[]>> => {
  const r = await hub.call("vault_import_search", { query }, ONEPASSWORD_MS);
  if (!r.ok) return r;
  const out = r.output as { items: readonly VaultImportCandidate[]; error?: string };
  return out.error === undefined ? { ok: true, value: known(out.items) } : failed(out.error);
};

export interface Imported {
  readonly items: readonly VaultItemSummary[];
  readonly errors: ReadonlyArray<{ ref: string; message: string }>;
}

/**
 * The ticked 1Password items brought into the vault: a machine holding the token reads them and seals them to the hub,
 * so their values never pass through the phone. From a lead's proposal (`proposalId`), where they go as it says; or
 * picked here, to the team vault. No scope either way.
 */
export const importItems = async (hub: VaultHub, i: { proposalId?: string; refs: readonly string[] }): Promise<Result<Imported>> => {
  const r = await hub.call("vault_import", { ...(i.proposalId === undefined ? {} : { proposalId: i.proposalId }), refs: i.refs }, ONEPASSWORD_MS);
  return r.ok ? { ok: true, value: r.output as Imported } : r;
};

/**
 * A set-aside item moved where it's used: a login, card or address to the team vault, a variable to the project picked
 * (refused when it has one of that name).
 */
export const moveItem = async (hub: VaultHub, itemId: string, project?: ProjectRef): Promise<Result<VaultItemSummary>> => {
  const r = await hub.call("vault_move", { itemId, ...(project === undefined ? {} : cleanRef(project)) });
  return r.ok ? { ok: true, value: (r.output as { item: VaultItemSummary }).item } : r;
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
  if (reason === "vault_update_app") return "This app is older than the hub. Update it to add vault items.";
  return undefined;
};
