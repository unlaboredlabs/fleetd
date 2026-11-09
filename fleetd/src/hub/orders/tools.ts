// orders_board and order_get. The attachments and project_files come with
// the intake port.
import type { OrderCard, Steer } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Registry } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { register as registerIntake } from "../intake/tools.ts";
import { decisions } from "../ledger/decisions.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { board, DONE_LANES, join, leadLane, lookups, ordersInScope, projectChanges } from "./index.ts";
import { leadGet, openRequests } from "./sources.ts";
import { workstreamGet } from "./workstreams.ts";

const ORDER_ASKS = 20;
const ORDER_DECISIONS = 50;
const ORDER_STEERS = 20;
/** The hub trims lanes, then PRs, so a board answer stays under this. */
const BOARD_MAX_BYTES = 64 * 1024;

export const unknownOrder = (id: string) => new ToolError("not_found", `No order ${id}.`, "Call orders_board to see open orders.");

const size = (cards: OrderCard[]) => Buffer.byteLength(JSON.stringify(cards));

/** An order's steers, newest first (hub/steer/store.rs `list`): read only, the steer area writes them. */
function steersOf(hub: Hub, workstreamId: string, limit: number): Steer[] {
  return hub.db.conn
    .query<{ data: string }, [string, number]>("SELECT data FROM steers WHERE workstream_id = ?1 ORDER BY n DESC LIMIT ?2")
    .all(workstreamId, limit)
    .map((r) => JSON.parse(r.data) as Steer);
}

export function register(tools: Registry): void {
  registerIntake(tools);
  tools.add("orders_board", (hub, caller, input) => {
    if (input.projectRef) requireRole(caller, "read", input.projectRef.machineId);
    const orders = ordersInScope(hub, caller, input.projectRef, input.includeDoneSince);
    const built = board(hub, orders);
    let { cards, truncated } = built;
    // Bounded for a remote app: drop lanes beyond the first 4 per card, then PRs, then whole cards.
    if (size(cards) > BOARD_MAX_BYTES) {
      truncated = true;
      cards = cards.map((c) => ({ ...c, lanes: c.lanes.slice(0, 4) }));
    }
    if (size(cards) > BOARD_MAX_BYTES) cards = cards.map((c) => ({ ...c, prs: c.prs.slice(0, 1) }));
    while (size(cards) > BOARD_MAX_BYTES && cards.length > 0) cards.pop();
    return {
      orders: cards,
      trains: built.trains,
      at: isoMs(hub.clock.now()),
      next: "Open one with order_get; subscribe to live lanes with the app's live frame.",
      ...(truncated ? { truncated: true } : {}),
    };
  });

  tools.add("order_get", (hub, caller, input) => {
    const id = input.workstreamId;
    const w = workstreamGet(hub.db.conn, id);
    if (!w || !allows(caller, "read", w.projectRef.machineId)) throw unknownOrder(id);
    const project = w.projectRef;
    let requests = openRequests(hub, 200, project).filter((r) => r.workstreamId === id);
    const joined = join(hub, w, projectChanges(hub, project), requests.length);
    let truncated = joined.truncated || requests.length > ORDER_ASKS;
    requests = requests.slice(0, ORDER_ASKS);
    const title = store(hub).projectGet(project)?.title ?? project.projectId;
    const lead = leadGet(hub, project);
    if (joined.done.length >= DONE_LANES) truncated = true;
    let decided = decisions(hub).list({ scope: { kind: "workstream", workstreamId: id }, limit: ORDER_DECISIONS + 1 });
    truncated ||= decided.length > ORDER_DECISIONS;
    decided = decided.slice(0, ORDER_DECISIONS);
    const steers = steersOf(hub, id, ORDER_STEERS).filter((s) => allows(caller, "read", s.thread.machineId));
    return {
      order: joined.card,
      workstream: w,
      ...(lead ? { lead: leadLane(lead, title, lookups(hub)) } : {}),
      doneLanes: joined.done,
      requests,
      decisions: decided,
      steers,
      next: "Talk to its lead with chat_send; stop the project's work with project_stop.",
      ...(truncated ? { truncated: true } : {}),
    };
  });
}
