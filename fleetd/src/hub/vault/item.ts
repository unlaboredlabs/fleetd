// A vault item as the hub and another repository read it without the database: its row and draft, the AAD's scope
// part, the refusals the store gives, who asks and for what work, what a save says, and its quiet line.
import { randomBytes } from "node:crypto";
import type { AgentKeyInfo, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Binding } from "./crypto.ts";
import { BRAND_NAMES, type Meta, type SinkMeta, type Source, type VaultKind, type VaultScope } from "./fields.ts";

/** The app feature the hub announces once it has a vault: apps show their Vault screens only then. */
export const FEATURE_VAULT = "vault";
/** The app feature of a hub with one team vault: no person's own items (but those set aside), no sharing. */
export const FEATURE_VAULT_TEAM = "vault_team";

/** One row of `vault_items`, as read. */
export type ItemRow = {
  itemId: string;
  kind: VaultKind;
  scope: VaultScope;
  personId?: string;
  machineId?: string;
  projectId?: string;
  workstreamId?: string;
  envName?: string;
  label: string;
  meta: Meta;
  sealed: Uint8Array;
  keyId: string;
  version: number;
  createdMs: number;
  createdBy: string;
  updatedMs: number;
  updatedBy: string;
  deletedMs?: number;
  /** The scope part of the AAD its version was sealed under, when the one-team-vault migration moved it since. */
  sealedScope?: string;
};

/** What a new or changed item is, before its fields are sealed. */
export type ItemDraft = Pick<ItemRow, "kind" | "scope" | "label" | "meta"> & {
  personId?: string;
  machineId?: string;
  projectId?: string;
  workstreamId?: string;
  envName?: string;
};

/** The most items the team vault, and one project, keep. */
export const ITEMS_MAX = 1000;
/** Deleted items stay in the trash this long, then go for good. */
export const TRASH_MS = 30 * 24 * 3600_000;

export const newItemId = () => `V${randomBytes(16).toString("hex")}`;

/** The scope part of an item's AAD. */
export function scopeKey(r: Pick<ItemRow, "scope" | "personId" | "machineId" | "projectId" | "workstreamId">): string {
  switch (r.scope) {
    case "person":
      return `person:${r.personId ?? ""}`;
    case "project":
      return `project:${r.machineId ?? ""}/${r.projectId ?? ""}`;
    case "order":
      return `order:${r.machineId ?? ""}/${r.projectId ?? ""}/${r.workstreamId ?? ""}`;
    case "hub":
      return "hub";
  }
}

export const bindingOf = (r: Pick<ItemRow, "itemId" | "kind" | "version" | "sealedScope"> & Parameters<typeof scopeKey>[0]): Binding => ({
  itemId: r.itemId,
  kind: r.kind,
  scopeKey: r.sealedScope ?? scopeKey(r),
  version: r.version,
});

export const locked = () =>
  new ToolError("failed", "The vault is locked.", "An owner or admin unlocks it in the app: Settings › You › Vault.", "vault_locked");
export const keyMissing = () =>
  new ToolError(
    "failed",
    "Can't open: the vault key is missing.",
    "Re-enter the recovery code with `fleetd vault restore-key` on the hub.",
    "vault_key_missing",
  );
export const damaged = (id: string) =>
  new ToolError("failed", `The vault item ${id} doesn't open: it was changed outside fleetd.`, "Delete it and save it again.");

/** An older app adding a person's own item, a hub-level one or a project's login: refused, never stored wider. */
export const updateApp = () =>
  new ToolError(
    "invalid",
    "This app is older than the hub: update it to add vault items.",
    "The hub keeps logins, cards and addresses in one team vault now, and variables per project.",
    "vault_update_app",
  );

/** Who is asking, as the access rules read them. */
export type Viewer = {
  caller: AgentKeyInfo;
  /** The person the key acts as: its own, or the hub's owner for a key with no person. */
  person?: string;
  /** Admin on every machine: changes and reveals every team item and project variable. */
  admin: boolean;
  human: boolean;
  /** The hub itself (the migration): it keeps a removed project's variables too, so nothing is lost. */
  system?: boolean;
};

/** The work an agent's session does, from the hub's own records: what it may use. */
export type UseContext = {
  projectRef: ProjectRef;
  taskId?: string;
  workstreamId?: string;
  /** Whose work it is, for the audit. */
  personId?: string;
  threadId?: string;
};

export type SaveSpec = {
  itemId?: string;
  kind?: VaultKind;
  scope?: VaultScope;
  machineId?: string;
  projectId?: string;
  workstreamId?: string;
  label?: string;
  sites?: string[];
  envName?: string;
  secret?: boolean;
  billingAddress?: string;
  /** The fields: all of them for a new item, only the changed ones for an edit. */
  fields?: unknown;
  source?: Source;
  sink?: SinkMeta;
  /** The node holds it already (the migration): no delivery now. */
  held?: boolean;
};


/**
 * A sink item's name in the vault: its own namespace, apart from the project's variables, and one per sink (secret
 * key, kind and path), since many requests write the same .env file.
 */
export const sinkEnvName = (sink: SinkMeta) => `sink:${sink.kind}:${sink.secretKey ?? ""}:${sink.path}`;

/** One quiet line about an item, for lists and chat: "Visa ••4242", "amazon.com", "Berlin, DE". Never a value. */
export function quietLine(kind: VaultKind, meta: Meta, envName?: string): string {
  switch (kind) {
    case "login":
      return meta.sites?.[0] ?? "";
    case "card":
      return `${BRAND_NAMES[meta.brand ?? "other"]} ••${meta.last4 ?? ""}`;
    case "address":
      return meta.country ?? "";
    case "env":
      return `${envName ?? ""}${meta.secret ? " · secret" : ""}`;
  }
}

export const isScope = (s: unknown): s is VaultScope => s === "person" || s === "project" || s === "order" || s === "hub";
