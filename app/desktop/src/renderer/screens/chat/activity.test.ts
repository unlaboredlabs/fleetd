import { describe, expect, it } from "vitest";
import type { HubEvent } from "../../../shared/contracts";
import { createDataStore, type DataState } from "../../src/data/store";
import { leadLaneId } from "../../src/data/selectors";
import { doingWords, leadActivity, turnTally } from "./activity";

const AT = "2026-10-19T10:00:00.000Z";
const ref = { machineId: "devbox", projectId: "storefront" };
const KEY = "devbox/storefront";
const ev = (seq: number, type: string, data?: unknown, projectId = ref.projectId, at = AT): HubEvent => ({
  seq,
  at,
  type,
  summary: type,
  machineId: "devbox",
  projectId,
  ...(data === undefined ? {} : { data }),
});
const BEFORE = "2026-10-19T09:00:00.000Z";
const started = (taskId: string, createdAt = AT) => ({ taskId, workstreamId: "W1", createdAt });
const working = (leadWorking: boolean) => ({ projectRef: ref, needsYou: false, leadWorking, lastSeq: 1 });

const state = (patch: Partial<DataState>): DataState => ({ ...createDataStore().getState(), fresh: true, ...patch });

describe("the lead's activity line", () => {
  it("says what the lead does now and what its turn did, from its lane and the turn's events", () => {
    const events = [
      ev(1, "task.started", started("T0", BEFORE), ref.projectId, BEFORE),
      ev(2, "chat.waiting", working(false), ref.projectId, BEFORE),
      ev(3, "chat.waiting", working(true)),
      ev(4, "workstream.created"),
      ev(5, "task.started", started("T1")),
      ev(6, "task.started", started("T9"), "elsewhere"),
      ev(7, "task.started", started("T2")),
    ];
    const lanes = {
      [leadLaneId(ref)]: { laneId: leadLaneId(ref), status: "working" as const, activity: { activity: { kind: "tool" as const, name: "mcp__fleetd__plan_add" }, since: AT } },
    };
    const s = state({ chatStates: { [KEY]: working(true) }, events, live: { ...createDataStore().getState().live, lanes } });
    // Only this project's events since it started working: the task before the turn and the other project's don't count.
    expect(leadActivity(s, KEY)).toBe("planning · opened an order · started 2 agents");
    // No lane yet (an older hub) and nothing done: the hub's word that it works.
    expect(leadActivity(state({ chatStates: { [KEY]: working(true) } }), KEY)).toBe("working");
  });

  it("counts from the turn's start, not from the hub saying again mid-turn that the lead works", () => {
    const events = [
      ev(1, "chat.waiting", working(false), ref.projectId, BEFORE),
      ev(2, "chat.waiting", working(true)),
      ev(3, "workstream.created"),
      ev(4, "task.started", started("T1")),
      // An approval card opened: the hub tells the state again, still working.
      ev(5, "chat.waiting", { ...working(true), needsYou: true }),
      ev(6, "task.started", started("T2")),
    ];
    expect(turnTally(events, ref)).toEqual(["opened an order", "started 2 agents"]);
    // The turn's start is no longer among the events: no count rather than part of one.
    expect(turnTally(events.slice(1), ref)).toEqual([]);
  });

  it("counts only the agents the turn spawned, once each", () => {
    const events = [
      ev(1, "chat.waiting", working(false), ref.projectId, BEFORE),
      ev(2, "chat.waiting", working(true)),
      // Queued by an earlier order, it got its slot now; and an earlier agent continued.
      ev(3, "task.started", started("T0", BEFORE)),
      ev(4, "task.started", started("T5", BEFORE)),
      ev(5, "task.started", started("T1")),
      // This turn's agent, continued after it finished once.
      ev(6, "task.started", started("T1")),
    ];
    expect(turnTally(events, ref)).toEqual(["started 1 agent"]);
  });

  it("is gone once the turn ends or the link is not fresh", () => {
    expect(leadActivity(state({ chatStates: { [KEY]: working(false) } }), KEY)).toBeUndefined();
    expect(leadActivity(state({ fresh: false, chatStates: { [KEY]: working(true) } }), KEY)).toBeUndefined();
  });

  it("speaks in plain words, never a raw tool name or command", () => {
    expect(doingWords({ kind: "read", path: "app/desktop/src/renderer/screens/chat/ChatList.tsx" })).toBe("reading `ChatList.tsx`");
    expect(doingWords({ kind: "read", pattern: "chat_delta" })).toBe("searching the code");
    expect(doingWords({ kind: "command", text: "cargo test -p fleetd" })).toBe("running a command");
    expect(doingWords({ kind: "tool", name: "mcp__fleetd__workstream_open" })).toBe("opening an order");
    expect(doingWords({ kind: "tool", name: "mcp__fleetd__something_new" })).toBe("asking fleetd");
    expect(doingWords({ kind: "tool", name: "mcp__other__x" })).toBe("working");
  });
});
