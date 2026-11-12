// A vault card as a purchase names and shows it, with no vault behind it (aliases.ts reads the vault).
import { ToolError } from "../../shared/errors.ts";

/** A `vault:V…` card reference's item id; undefined for an `op://` one. */
export const vaultCardId = (ref: string | undefined) => (ref !== undefined && /^vault:V[0-9a-f]{32}$/.test(ref) ? ref.slice(6) : undefined);

/** The vault card's label as the chat and the apps show it: "Visa (Personal) ••4242", from its item's label and meta. */
export const cardShown = (label: string, meta: { brand?: string; last4?: string }): { label: string; brand?: string; last4?: string } => ({
  label: `${label} ••${meta.last4 ?? ""}`,
  ...(meta.brand !== undefined ? { brand: meta.brand } : {}),
  ...(meta.last4 !== undefined ? { last4: meta.last4 } : {}),
});

/** A card a person picks for a project that is no live card of the team vault. */
export const notInVault = () => new ToolError("invalid", "That card isn't in the team vault.", "Pick one of the team vault's cards, or add one in Settings › Vault.");
