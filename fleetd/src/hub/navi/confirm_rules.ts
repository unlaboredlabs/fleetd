// `confirm_step`'s rules, without the hub (confirm.ts): reading the call, refusing one that pays, orders or trades,
// and the card a prompt for it shows.
import type { ToolPreview } from "../../shared/contracts.ts";
import { clipUtf16, never, sortedValue, words } from "../integrations/policy.ts";

/** The tool as a Navi's session asks for it. */
export const TOOL = "mcp__fleetd__confirm_step";

/** fleetd-contracts navi.rs `ConfirmStepCall`. */
export type ConfirmStepCall = { site: string; button: string; does: string; page?: string; screenshot?: string };

/** A `Line<1, max>`: a single line of 1 to `max` UTF-16 units. */
const line = (v: unknown, max: number): v is string => typeof v === "string" && v.length >= 1 && v.length <= max && !/[\r\n]/.test(v);

/** The call as serde reads it, or undefined for one it can't. */
export function decodeCall(input: unknown): ConfirmStepCall | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const o = input as Record<string, unknown>;
  if (!line(o.site, 253) || !line(o.button, 120) || !line(o.does, 500)) return undefined;
  if (o.page != null && (typeof o.page !== "string" || o.page.length > 4000)) return undefined;
  if (o.screenshot != null && typeof o.screenshot !== "string") return undefined;
  return {
    site: o.site,
    button: o.button,
    does: o.does,
    ...(typeof o.page === "string" ? { page: o.page } : {}),
    ...(typeof o.screenshot === "string" ? { screenshot: o.screenshot } : {}),
  };
}

/** The words of a step that pays or trades: those go to the person, never through `confirm_step`. */
const PAYS = ["pay", "payment", "purchase", "buy", "checkout", "donate", "subscribe", "tip", "transfer", "send"];

/** Words of a step that undoes an order rather than placing one. */
const UNDO = ["cancel", "return", "refund"];

/** Verbs of a step that places, buys or pays: with any of them, the step is a purchase whatever else it says. */
const PLACING = [
  "place", "places", "placing", "buy", "buys", "buying", "purchase", "purchases", "pay", "pays", "paying", "checkout",
  "submit order", "confirm order", "complete order",
];

/** Why a `confirm_step` is refused: it pays, orders or trades (by its button or what it does), or it can't be read. */
export function refused(input: unknown): string | undefined {
  const call = decodeCall(input);
  if (!call) return "Blocked by fleetd: this confirm_step can't be read. Give site, button and does.";
  const text = `${call.button} ${call.does}`;
  const w = words(text);
  const has = (list: string[]) => w.some((x) => list.includes(x));
  // Undoing an order goes through the Navi's mode like any final click (decision navi.final-confirm-by-mode), but only
  // when the button itself says so (Cancel, Return, Refund) and nothing in the step places, buys or pays: "free
  // returns" in what a Place order does undoes nothing.
  const button = words(call.button);
  const lower = text.toLowerCase();
  const placing = PLACING.some((p) => (p.includes(" ") ? lower.includes(p) : w.includes(p)));
  const undoes = button.some((x) => UNDO.includes(x)) && !placing;
  const ordered = has(["order", "orders", "ordering"]) && !undoes;
  const n = never(text);
  const forbidden = n !== undefined && (!undoes || n === "money") ? n : undefined;
  const money =
    w.some((x) => PAYS.includes(x) && x !== "send") ||
    ordered ||
    w.some((x, i) => x === "send" && ["money", "payment"].includes(w[i + 1] ?? "")) ||
    forbidden !== undefined;
  return money
    ? "Blocked by fleetd: this step pays, orders or trades, which confirm_step never does. Hand the final click to " +
        "the person with request_takeover."
    : undefined;
}

/** The card's heading and everything it shows, for a `confirm_step` prompt. */
export function preview(input: unknown): ToolPreview | undefined {
  const call = decodeCall(input);
  if (!call) return undefined;
  return {
    server: "fleetd",
    tool: "confirm_step",
    action: "confirm",
    title: clipUtf16(`Click "${call.button}" on ${call.site}`, 200),
    input: JSON.stringify(sortedValue(input), null, 2),
  };
}
