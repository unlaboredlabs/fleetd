// The order the lead's latest finished turn closed, if one: its reply says the order's whole time and its agents
// ("Done in 3m 10s · 3 agents") rather than the turn's own seconds, and "Worked for…" opens what the turn did. Only
// real state: the workspace's workstream.done event inside the turn, and the order's own start and agents.
import { eventData, isEvent, type HubEvent, type OrderGetOutput } from "../../../shared/contracts";
import { orderAgents, orderStamp } from "../../../shared/stamp";
import type { DataState, ProjectKey } from "../../src/data/store";
import { lastTurn } from "./activity";

/** A reply written just after its turn's idle still counts as its (model.ts's REPLY_SLACK_MS). */
const SLACK_MS = 2_000;

/** The `workstream.done` of the project inside its lead's latest finished turn; undefined when it closed none. */
export const leadLastTurnClosed = (s: DataState, key: ProjectKey): HubEvent | undefined => {
  const at = key.indexOf("/");
  const ref = { machineId: key.slice(0, at), projectId: key.slice(at + 1) };
  const turn = lastTurn(s.events, ref);
  if (turn === undefined) return undefined;
  const since = Date.parse(s.events[turn.start]?.at ?? "");
  const until = Date.parse(s.events[turn.end]?.at ?? "");
  return s.events.findLast((e) => {
    if (!isEvent(e, "workstream.done") || e.machineId !== ref.machineId || e.projectId !== ref.projectId) return false;
    const t = Date.parse(e.at);
    return t >= since && t <= until + SLACK_MS;
  });
};

/** The order a `workstream.done` names. */
export const closedOrderId = (e: HubEvent | undefined): string | undefined =>
  e !== undefined && isEvent(e, "workstream.done") ? eventData(e)?.workstreamId : undefined;

/** The closed order's whole time, its start to the event that closed it, and its agents; undefined while unread. */
export const closedOrderStamp = (done: HubEvent | undefined, order: Pick<OrderGetOutput, "order" | "doneLanes"> | undefined): { ms: number; agents: number } | undefined =>
  done === undefined || order === undefined ? undefined : orderStamp(done.at, order);

export { orderAgents };
