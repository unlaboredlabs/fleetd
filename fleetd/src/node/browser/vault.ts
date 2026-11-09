// Fills from fleetd's own vault (vault-design §4; the hub's side is hub/vault/calls.ts). The node hosting a browser
// session asks the hub for one item's field for the page it's on (`vault_fill`, in the session's name; a session hosted
// for an agent on another machine asks too, so the value never touches the agent's machine). The hub decides who the
// session works for from its own records, checks the item's scope, kind and site and the rate limits, writes the audit
// row, and answers with the value sealed to this node's box key. The node opens it, checks the page against the item's
// sites once more, fills over its own connection exactly as a 1Password fill does (credentials.ts, cards.ts,
// address.ts), and tells the hub how it went (`vault_filled`). A value is masked as `***vault:<label>/<field>***`.
import type { AddressSecret, CardSecret, VaultFillPlain } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Broker } from "./index.ts";
import { type Card, hostOf } from "./onepassword.ts";
import type { Session } from "./session.ts";

/** Hosting suffixes whose subdomains belong to different people: a site on one matches only as its whole host
 * (vault.rs `SHARED_HOSTING`). */
export const SHARED_HOSTING = [
  "github.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "herokuapp.com",
  "web.app",
  "firebaseapp.com",
  "azurewebsites.net",
  "cloudfront.net",
  "appspot.com",
];

const under = (host: string, domain: string) => host === domain || (host.endsWith(domain) && host.slice(0, host.length - domain.length).endsWith("."));

/** Whether a page on `host` is on an item's `site` (vault.rs `on_site`): the same host or a subdomain of it. A site
 * with no dot matches nothing, and one on a shared-hosting suffix only its whole host. */
export function onSite(host: string, site: string): boolean {
  const h = host.toLowerCase();
  const s = (hostOf(site) ?? site).toLowerCase();
  if (!s.includes(".")) return false;
  if (SHARED_HOSTING.some((suffix) => under(s, suffix))) return h === s;
  return under(h, s);
}

/** Whether the document at `url` is on one of `sites`. */
export const onSites = (url: string, sites: string[]) => {
  const host = hostOf(url);
  return host !== undefined && sites.some((s) => onSite(host, s));
};

/** How a vault value is named where it's masked: `vault:Amazon/password`. */
export const maskName = (label: string, field: string) => `vault:${label}/${field}`;

/** What one `vault_fill` gave: the item, its audit row, and the opened value. */
export type VaultFilled = { itemId: string; label: string; auditId: number; plain: VaultFillPlain };

/** What a fill names: a vault item (id or label) or, for one release, the `op://` reference it was imported from. */
export type VaultAsk = { item?: string; ref?: string; field: "username" | "password" | "otp" | "address"; page: string; frame?: string };

/** Whether the hub's refusal of a `ref` fill means "not in the vault": the item was never imported, or the hub has no
 * vault yet. Only then does a `ref` fill fall back to 1Password. */
export const notInVault = (e: unknown) =>
  e instanceof ToolError &&
  (e.reason === "vault_not_imported" || e.reason === NO_VAULT || /does not take lead-side calls|not a lead call|unknown (lead )?call/i.test(e.message));

/** The reason a fill gives when the hub answered `vault_fill` with no fill at all: a hub from before the vault. */
const NO_VAULT = "vault_unavailable";

/** A sealed box from the hub, opened with this node's box key, as JSON. Throws without saying what it held. */
export function openSealed<T>(broker: Broker, sealed: unknown, what: string): T {
  const bytes = typeof sealed === "string" && sealed ? broker.boxKey().open(Buffer.from(sealed, "base64")) : null;
  if (!bytes) throw new ToolError("failed", `${what} from the hub did not open on this machine.`, "try again; if it keeps failing, the machine's box key changed: restart its node");
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new ToolError("failed", `${what} from the hub is not what fleetd seals.`);
  } finally {
    bytes.fill(0);
  }
}

/** Asks the hub for a field of an item, for the page the session is on; its refusal is thrown as the hub words it. */
export async function vaultFill(broker: Broker, session: Session, ask: VaultAsk): Promise<VaultFilled> {
  const answer = await broker.inTurn(session, "vault_fill", {
    sessionId: session.id,
    ...(ask.item !== undefined ? { item: ask.item } : {}),
    ...(ask.ref !== undefined ? { ref: ask.ref } : {}),
    field: ask.field,
    page: [...ask.page].slice(0, 2000).join(""),
    ...(ask.frame !== undefined ? { frame: [...ask.frame].slice(0, 2000).join("") } : {}),
  });
  if (answer.sealed === undefined && answer.auditId === undefined) {
    throw new ToolError("failed", "This hub has no vault to fill from.", "update fleetd on the hub, or fill with a 1Password ref", NO_VAULT);
  }
  const auditId = Number(answer.auditId);
  const label = String(answer.label ?? ask.item ?? "the item");
  let plain: VaultFillPlain;
  try {
    plain = openSealed<VaultFillPlain>(broker, answer.sealed, `${label}'s ${ask.field}`);
  } catch (e) {
    await vaultFilled(broker, session, auditId, false, false, "the value did not open on the node");
    throw e;
  }
  if (!Array.isArray(plain.sites)) plain.sites = [];
  return { itemId: String(answer.itemId ?? ""), label, auditId, plain };
}

/** Tells the hub how a fill went, for its audit row; never throws, and never says a value. */
export async function vaultFilled(broker: Broker, session: Session, auditId: number, ok: boolean, typed: boolean, message: string): Promise<void> {
  if (!Number.isInteger(auditId) || auditId < 1) return;
  try {
    const line = [...(session.scrub().text(message).split("\n")[0] ?? "")].slice(0, 500).join("").trim();
    await broker.inTurn(session, "vault_filled", { auditId, ok, typed, ...(line ? { message: line } : {}) });
  } catch (e) {
    console.warn(`browser ${session.id}: vault fill ${auditId} was not reported: ${(e as Error).message}`);
  }
}

/** A purchase claim's `sealedCard`, opened: the card as the fill takes it. */
export function openCard(broker: Broker, sealed: unknown): Card {
  const card = openSealed<CardSecret>(broker, sealed, "The card");
  const number = String(card.number ?? "").replace(/[^0-9]/g, "");
  const month = String(card.month ?? "").padStart(2, "0");
  const year = String(card.year ?? "");
  if (number.length < 12) throw new ToolError("failed", "The vault card has no card number.", "ask the person to check the card in Settings › Vault");
  if (!/^(0[1-9]|1[0-2])$/.test(month) || !/^\d{4}$/.test(year)) throw new ToolError("failed", "The vault card has no expiry date fleetd can read.", "ask the person to check the card in Settings › Vault");
  return { number, month, year, cvc: String(card.cvc ?? ""), name: String(card.name ?? "") };
}

/** An address's parts that are a person's own, scrubbed from all the driver sees once filled (a country or region
 * code is too short and too common to scrub). */
export const ADDRESS_SECRET_PARTS: (keyof AddressSecret)[] = ["name", "organization", "line1", "line2", "city", "postalCode", "phone", "email"];
