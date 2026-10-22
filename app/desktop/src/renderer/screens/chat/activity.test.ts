import { describe, expect, it } from "vitest";
import type { HubEvent } from "../../../shared/contracts";
import { createDataStore, type DataState } from "../../src/data/store";
import { leadLaneId } from "../../src/data/selectors";
import { doingWords, leadActivity } from "./activity";

const AT = "2026-10-19T10:00:00.000Z";
const ref = { machineId: "devbox", projectId: "storefront" };
const KEY = "devbox/storefront";
const ev = (seq: number, type: string, data?: unknown, projectId = ref.projectId): HubEvent => ({
  seq,
  at: AT,
  type,
  summary: type,
  machineId: "devbox",
  projectId,
  ...(data === undefined ? {} : { data }),
});
const working = (leadWorking: boolean) => ({ projectRef: ref, needsYou: false, leadWorking, lastSeq: 1 });

const state = (patch: Partial<DataState>): DataState => ({ ...createDataStore().getState(), fresh: true, ...patch });

describe("the lead's activity line", () => {
  it("says what the lead does now and what its turn did, from its lane and the turn's events", () => {
    const events = [
      ev(1, "task.started"),
      ev(2, "chat.waiting", working(true)),
      ev(3, "workstream.created"),
      ev(4, "task.started"),
      ev(5, "task.started", undefined, "elsewhere"),
      ev(6, "task.started"),
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

  it("is gone once the turn ends or the link is not fresh", () => {
    expect(leadActivity(state({ chatStates: { [KEY]: working(false) } }), KEY)).toBeUndefined();
    expect(leadActivity(state({ fresh: false, chatStates: { [KEY]: working(true) } }), KEY)).toBeUndefined();
  });

  it("speaks in plain words, never a raw tool name or command", () => {
    expect(doingWords({ kind: "read", path: "app/desktop/src/renderer/screens/chat/ChatList.tsx" })).toBe("reading `ChatList.tsx`");
    expect(doingWords({ kind: "read", pattern: "chat_delta" })).toBe("searching the code");
    expect(doingWords({ kind: "command", text: "cargo test -p fleetd" })).toBe("running a command");
    expect(doingWords({ kind: "tool", name: "mcp__fleetd__workstream_spawn" })).toBe("starting agents");
    expect(doingWords({ kind: "tool", name: "mcp__fleetd__something_new" })).toBe("asking fleetd");
    expect(doingWords({ kind: "tool", name: "mcp__other__x" })).toBe("working");
  });
});
