// What the order tools answer within, without the hub (tools.ts reads the board): how many asks, decisions and steers
// an order shows, the board's byte bound and its trim, and the refusal for an order that isn't there.
import type { OrderCard } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";

export const ORDER_ASKS = 20;
export const ORDER_DECISIONS = 50;
export const ORDER_STEERS = 20;
/** The hub trims lanes, then PRs, so a board answer stays under this. */
export const BOARD_MAX_BYTES = 64 * 1024;

export const unknownOrder = (id: string) => new ToolError("not_found", `No order ${id}.`, "Call orders_board to see open orders.");

export const size = (cards: OrderCard[]) => Buffer.byteLength(JSON.stringify(cards));

/** The board's cards bounded for a remote app: lanes beyond the first 4 per card dropped, then PRs, then whole cards. */
export function trimmed(cards: OrderCard[], truncated: boolean): { cards: OrderCard[]; truncated: boolean } {
  if (size(cards) > BOARD_MAX_BYTES) {
    truncated = true;
    cards = cards.map((c) => ({ ...c, lanes: c.lanes.slice(0, 4) }));
  }
  if (size(cards) > BOARD_MAX_BYTES) cards = cards.map((c) => ({ ...c, prs: c.prs.slice(0, 1) }));
  while (size(cards) > BOARD_MAX_BYTES && cards.length > 0) cards.pop();
  return { cards, truncated };
}
