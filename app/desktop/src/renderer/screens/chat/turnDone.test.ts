import { describe, expect, it } from "vitest";
import type { AgentLane, HubEvent, OrderGetOutput } from "../../../shared/contracts";
import { createDataStore, type DataState } from "../../src/data/store";
import { closedOrderId, closedOrderStamp, leadLastTurnClosed, orderAgents } from "./turnDone";

const ref = { machineId: "devbox", projectId: "storefront" };
const KEY = "devbox/storefront";
const t = (m: number, s = 0) => `2026-11-26T18:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;
const ev = (seq: number, type: string, at: string, data?: unknown, projectId = ref.projectId): HubEvent => ({
  seq,
  at,
  type,
  summary: type,
  machineId: ref.machineId,
  projectId,
  ...(data === undefined ? {} : { data }),
});
const waiting = (leadWorking: boolean) => ({ projectRef: ref, needsYou: false, leadWorking, lastSeq: 1 });
const state = (events: HubEvent[]): DataState => ({ ...createDataStore().getState(), fresh: true, events });
const lane = (taskId: string | undefined, role: AgentLane["role"]): AgentLane => ({ laneId: taskId ?? "lead", role, status: "done", title: taskId ?? "lead", ...(taskId === undefined ? {} : { taskId }) });

describe("the order a turn closed", () => {
  const events = [
    ev(1, "chat.waiting", t(0), waiting(false)),
    ev(2, "chat.waiting", t(0, 1), waiting(true)),
    ev(3, "chat.waiting", t(0, 20), waiting(false)),
    // The agents work three minutes while the lead is idle; then its closing turn.
    ev(4, "chat.waiting", t(3, 0), waiting(true)),
    ev(5, "workstream.done", t(3, 8), { workstreamId: "W7" }),
    ev(6, "chat.waiting", t(3, 10), waiting(false)),
  ];

  it("is the workstream.done inside the lead's latest finished turn", () => {
    const done = leadLastTurnClosed(state(events), KEY);
    expect(closedOrderId(done)).toBe("W7");
    // One closed in an earlier turn, or another bot's, is not this turn's.
    const idle = ev(6, "chat.waiting", t(3, 10), waiting(false));
    expect(leadLastTurnClosed(state([...events.slice(0, 4), ev(5, "chat.note", t(3, 8)), idle]), KEY)).toBeUndefined();
    expect(leadLastTurnClosed(state([...events.slice(0, 4), ev(5, "workstream.done", t(3, 8), { workstreamId: "W7" }, "other"), idle]), KEY)).toBeUndefined();
  });

  it("is stamped with its whole time and the agents its lead started, never the lead or the train's reviewers", () => {
    const order = {
      order: { createdAt: t(0, 0), lanes: [lane("T2", "implementer")] },
      doneLanes: [lane("T1", "implementer"), lane("T2", "implementer"), lane("T3", "reader"), lane("T4", "reviewer"), lane(undefined, "lead")],
    } as unknown as OrderGetOutput;
    expect(orderAgents(order).map((l) => l.taskId)).toEqual(["T2", "T1", "T3"]);
    expect(closedOrderStamp(leadLastTurnClosed(state(events), KEY), order)).toEqual({ ms: 188_000, agents: 3 });
    expect(closedOrderStamp(undefined, order)).toBeUndefined();
  });
});
