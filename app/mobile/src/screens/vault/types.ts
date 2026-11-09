// The vault's wire shapes as the phone reads them (vault-design §3, §4.6, §6, pinned by part 1's contracts).
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
  readonly updatedBy?: string | undefined;
  readonly deletedMs?: number | undefined;
  readonly canEdit: boolean;
  readonly canReveal: boolean;
}

export interface VaultAuditEntry {
  readonly n: number;
  readonly atMs: number;
  readonly itemId: string;
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
  readonly keyMode?: string | undefined;
  readonly recoverySaved?: boolean | undefined;
}

/** A 1Password item's overview, never its values. */
export interface VaultImportHit {
  readonly ref: string;
  readonly title: string;
  readonly kind: VaultKind;
  readonly site?: string | undefined;
  readonly vault?: string | undefined;
}

/** The card a lead's import proposal puts in the chat (a system message's `vaultImport`). */
export interface VaultImportCard {
  readonly proposalId: string;
  readonly why: string;
  readonly scope: VaultScope;
  readonly items: readonly VaultImportHit[];
  readonly state: "open" | "imported" | "dismissed";
  readonly imported?: number | undefined;
  readonly answeredAt?: string | undefined;
}
