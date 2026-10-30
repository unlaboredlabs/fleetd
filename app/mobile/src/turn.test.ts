import { describe, expect, it } from "vitest";
import type { HubEvent, LiveFrame, ProjectChatState } from "./desktop";
import { initial, reduce, type State } from "./store";
import { codeRuns, leadActivityOf, SWEEP, turnView } from "./turn";

const KEY = "m1/shop";
const REF = { machineId: "m1", projectId: "shop" };
const live = { phase: "live", hub: "http://devbox:4790", protocol: 1 } as const;

const waiting = (seq: number, at: string, leadWorking: boolean): HubEvent =>
  ({ seq, type: "chat.waiting", at, machineId: "m1", projectId: "shop", data: { projectRef: REF, lastSeq: 3, leadWorking, needsYou: false } satisfies ProjectChatState }) as HubEvent;
const frame = (full: boolean, lanes: LiveFrame["lanes"]): LiveFrame => ({ at: "2026-10-28T10:00:00Z", full, lanes });
const event = (s: State, e: HubEvent): State => reduce(s, { t: "frame", frame: { t: "event", event: e }, nowMs: 0 });
const liveFrame = (s: State, f: LiveFrame): State => reduce(s, { t: "frame", frame: { t: "live", frame: f }, nowMs: 0 });

describe("the turn line", () => {
  it("says what the lead does in the desktop's words, thinking on its ring and the rest as grain", () => {
    expect(turnView({ kind: "thinking" }, undefined, 0)).toEqual({ glyph: "thinking", now: "Thinking" });
    expect(turnView({ kind: "planning" }, undefined, 0).glyph).toBe("thinking");
    expect(turnView({ kind: "edit", path: "app/src/a.ts" }, undefined, 0)).toEqual({ glyph: "working", now: "Editing `a.ts`" });
    expect(turnView({ kind: "tool", server: "fleetd", name: "brief" }, undefined, 0).now).toBe("Briefing an agent");
    // Nothing more than "working" known: the line says so.
    expect(turnView(undefined, undefined, 0)).toEqual({ glyph: "working", now: "Working" });
  });

  it("counts how long the turn has run once its start is known", () => {
    expect(turnView(undefined, 1000, 73_000).count).toBe("1m 12s");
    expect(turnView(undefined, 5000, 1000).count).toBe("0s");
  });

  it("sets a file's name as code", () => {
    expect(codeRuns("Editing `a.ts`")).toEqual([
      { text: "Editing ", code: false },
      { text: "a.ts", code: true },
    ]);
    expect(codeRuns("Thinking")).toEqual([{ text: "Thinking", code: false }]);
  });

  it("scans the words on the desktop's 14 steps, then rests off them", () => {
    expect(SWEEP).toHaveLength(14);
    expect(SWEEP[0]).toBeLessThan(-1);
  });
});

describe("what the store keeps for it", () => {
  it("keeps the lead's activity from its live lane, a delta changing only the lanes it names", () => {
    let s = liveFrame(initial(live), frame(true, [{ laneId: "lead:m1/shop", status: "working", activity: { activity: { kind: "thinking" }, since: "2026-10-28T10:00:00Z" } }]));
    expect(leadActivityOf(s, KEY)).toEqual({ kind: "thinking" });
    const same = liveFrame(s, frame(false, []));
    expect(same).toBe(s);
    s = liveFrame(s, frame(false, [{ laneId: "lead:m1/shop", status: "working", activity: { activity: { kind: "read", path: "src/b.ts" }, since: "2026-10-28T10:00:01Z" } }]));
    expect(leadActivityOf(s, KEY)).toEqual({ kind: "read", path: "src/b.ts" });
    s = liveFrame(s, frame(false, [{ laneId: "lead:m1/shop", status: "working" }]));
    expect(leadActivityOf(s, KEY)).toBeUndefined();
  });

  it("forgets it when the link drops", () => {
    const s = liveFrame(initial(live), frame(true, [{ laneId: "lead:m1/shop", status: "working", activity: { activity: { kind: "thinking" }, since: "2026-10-28T10:00:00Z" } }]));
    const dropped = reduce(s, { t: "frame", frame: { t: "state", state: { phase: "retrying", hub: "http://devbox:4790", reason: "gone", retryAt: 500 } }, nowMs: 0 });
    expect(leadActivityOf(dropped, KEY)).toBeUndefined();
  });

  it("marks when a turn began, not again when the hub says working mid-turn, and forgets it when it ends", () => {
    let s = event(initial(live), waiting(1, "2026-10-28T10:00:00Z", true));
    expect(s.turnSince[KEY]).toBe(Date.parse("2026-10-28T10:00:00Z"));
    s = event(s, waiting(2, "2026-10-28T10:00:30Z", true));
    expect(s.turnSince[KEY]).toBe(Date.parse("2026-10-28T10:00:00Z"));
    s = event(s, waiting(3, "2026-10-28T10:01:00Z", false));
    expect(s.turnSince[KEY]).toBeUndefined();
  });
});
