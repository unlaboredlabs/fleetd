// The vault's wire shapes as the phone reads them (the generated contracts, vault-design §3, §4.6, §6), with the kind
// narrowed to the four this app knows: an item of a kind from a newer hub is left out of its lists (api.ts), and an
// import card's item of one shows plainer (ImportCard.tsx).
import type { KnownVaultKind, VaultScope, VaultStatusOutput, WireVaultAuditEntry, WireVaultImportCandidate, WireVaultImportCard, WireVaultItemSummary } from "../../desktop";

export type VaultKind = KnownVaultKind;
export type { VaultScope };

export type VaultItemSummary = Omit<WireVaultItemSummary, "kind"> & { readonly kind: VaultKind };
export type VaultImportCandidate = Omit<WireVaultImportCandidate, "kind"> & { readonly kind: VaultKind };
export type VaultAuditEntry = WireVaultAuditEntry;
export type VaultImportCard = WireVaultImportCard;
export type VaultStatus = VaultStatusOutput;
