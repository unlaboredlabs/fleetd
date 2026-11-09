// The vault's wire shapes as the phone reads them (vault-design §3, §4.6, §6; crates/fleetd-contracts/src/vault.rs).
// Kinds are the four this app knows: an item of a kind from a newer hub is left out of its lists (api.ts).
import type { ProjectRef } from "../../desktop";

export type VaultKind = "login" | "card" | "address" | "env";
export type VaultScope = "person" | "project" | "order" | "hub";

export interface VaultItemSummary {
  readonly itemId: string;
  readonly kind: VaultKind;
  readonly scope: VaultScope;
  readonly label: string;
  /** Readable metadata the hub works out from the value: sites, brand and last 4, country, secret, fields. */
  readonly meta: Readonly<Record<string, unknown>>;
  readonly envName?: string | undefined;
  readonly personId?: string | undefined;
  readonly machineId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly workstreamId?: string | undefined;
  readonly sharedWith?: readonly ProjectRef[] | undefined;
  readonly createdMs: number;
  readonly updatedMs: number;
  readonly updatedBy: string;
  readonly deletedMs?: number | undefined;
  readonly version: number;
  /** A plain (not secret) variable's value, which shows without a reveal. */
  readonly value?: string | undefined;
  readonly canEdit: boolean;
  readonly canReveal: boolean;
}

export interface VaultAuditEntry {
  readonly n: number;
  readonly atMs: number;
  readonly itemId?: string | undefined;
  readonly action: string;
  readonly outcome: string;
  readonly personId?: string | undefined;
  readonly machineId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface VaultStatus {
  /** The hub's box key (X25519, base64): what a value is sealed to on its way to the hub. */
  readonly hubBoxKey: string;
  readonly locked: boolean;
  readonly keyMissing: boolean;
  readonly keyMode: string;
  readonly recoverySaved: boolean;
}

/** A 1Password item's overview for the import list, never its values. */
export interface VaultImportCandidate {
  readonly ref: string;
  readonly title: string;
  readonly kind: VaultKind;
  readonly sites?: readonly string[] | undefined;
  readonly vault: string;
  /** Already in the vault, imported from it: that item. */
  readonly imported?: string | undefined;
}

export interface VaultImportCardItem {
  readonly ref: string;
  readonly title: string;
  readonly kind: VaultKind;
  readonly site?: string | undefined;
}

/** The card a lead's import proposal puts in the chat (a system message's `vaultImport`). */
export interface VaultImportCard {
  readonly proposalId: string;
  readonly why: string;
  readonly scope: VaultScope;
  readonly items: readonly VaultImportCardItem[];
  readonly state: "open" | "imported" | "dismissed";
  readonly imported?: number | undefined;
  readonly answeredMs?: number | undefined;
}
