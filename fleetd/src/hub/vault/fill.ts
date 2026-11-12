// Where and how often a vault item fills (calls.ts runs the fills): the hourly limits, which sites a page's host is on,
// and which item a fill names.
import { ToolError } from "../../shared/errors.ts";
import type { ItemRow } from "./item.ts";

/** 30 fills an hour per item per project; 300 an hour per browser host. */
export const FILLS_PER_ITEM_HOUR = 30;
export const FILLS_PER_HOST_HOUR = 300;
/** Hosts many strangers share: an item for one matches only that exact host, never a neighbour. */
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

/**
 * Whether a page on `host` is the item's `site`: the same host, or a subdomain of it. A site with no dot never
 * matches, a bare shared-hosting suffix never matches, and a site on shared hosting matches only itself.
 */
export function onSite(host: string, site: string): boolean {
  const h = host.toLowerCase();
  const s = site.toLowerCase();
  if (!s.includes(".") || SHARED_HOSTING.includes(s)) return false;
  if (h === s) return true;
  if (SHARED_HOSTING.some((x) => s === x || s.endsWith(`.${x}`))) return false;
  return h.endsWith(`.${s}`);
}

export const onAny = (host: string, sites: string[] | undefined) => (sites ?? []).some((s) => onSite(host, s));

/** The usable item a call names: a V-id, a label unique among usable ones, or an `op://` reference it was imported from. */
export function resolve(rows: ItemRow[], item: unknown, ref: unknown): ItemRow {
  if (typeof ref === "string") {
    const base = /^op:\/\/[^/?\r\n]+\/[^/?\r\n]+/.exec(ref)?.[0];
    const hit = rows.find((r) => r.meta.source?.kind === "1password" && r.meta.source.ref === base);
    if (hit) return hit;
    throw new ToolError(
      "not_found",
      `${base ?? "That reference"} isn't in fleetd's vault yet.`,
      "Find it with vault_import_search and propose importing it with vault_import_propose; the person confirms.",
      "vault_not_imported",
    );
  }
  if (typeof item !== "string" || item === "") throw new ToolError("invalid", "Name an item: its id or its label.");
  const byId = rows.find((r) => r.itemId === item);
  if (byId) return byId;
  const byLabel = rows.filter((r) => r.label.toLowerCase() === item.toLowerCase());
  if (byLabel.length === 1) return byLabel[0]!;
  if (byLabel.length > 1) throw new ToolError("invalid", `Several items are called ${item}.`, "Name one by its id from vault_items.");
  throw new ToolError("not_found", `No vault item ${item} this session may use.`, "List them with vault_items.");
}
