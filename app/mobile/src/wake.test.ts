import { describe, expect, it } from "vitest";
import { botOf } from "./botState";
import { leadLaneId } from "./desktop";
import { wakeIn } from "./wake";

const ref = { machineId: "devbox", projectId: "w1" };
const KEY = "devbox/w1";
const chat = (over: object) => ({ chatStates: { [KEY]: { projectRef: ref, needsYou: false, leadWorking: false, lastSeq: 1, ...over } }, leadActivity: {}, requests: [], running: {} }) as never;
const lane = (activity: object) => ({ [leadLaneId(ref)]: activity });

describe("a cloud bot waking on the phone", () => {
  it("sleeps with its computer in every list, and wakes while it starts", () => {
    expect(botOf(chat({ leadAsleep: true }), KEY)).toBe("asleep");
    // A new reply not yet seen says so over its sleep.
    expect(botOf(chat({ leadAsleep: true }), KEY, true)).toBe("done");
    const starting = { ...(chat({ leadWorking: true }) as object), leadActivity: lane({ kind: "starting", text: "Starting its computer at boat.dev", step: "box" }) } as never;
    expect(botOf(starting, KEY)).toBe("waking");
    const failed = { ...(chat({ leadWorking: true }) as object), leadActivity: lane({ kind: "starting", text: "…", step: "box", failed: { reason: "No computer was free" } }) } as never;
    expect(botOf(failed, KEY)).toBe("error");
  });

  it("stands in the reply's place from its start through its lead's thinking, as the desktop's", () => {
    const k = "devbox/w2";
    const r = { machineId: "devbox", projectId: "w2" };
    const at = (leadWorking: boolean, activity?: object) =>
      ({ chatStates: { [k]: { projectRef: r, needsYou: false, leadWorking, lastSeq: 1 } }, leadActivity: activity === undefined ? {} : { [leadLaneId(r)]: activity } }) as never;
    // An awake bot's turn: nothing new.
    expect(wakeIn(at(true, { kind: "thinking" }), k)).toBeUndefined();
    expect(wakeIn(at(false), k)).toBeUndefined();
    expect(wakeIn(at(true, { kind: "starting", text: "Starting its computer", step: "files", startedAt: "2026-11-22T10:00:00.000Z" }), k)).toEqual({ phase: "waking", step: "files", since: Date.parse("2026-11-22T10:00:00.000Z") });
    expect(wakeIn(at(true, { kind: "thinking" }), k)).toEqual({ phase: "thinking" });
    expect(wakeIn(at(true, { kind: "writing" }), k, true)).toEqual({ phase: "writing" });
    // Its turn over, the next one starts warm.
    expect(wakeIn(at(false), k)).toBeUndefined();
    expect(wakeIn(at(true, { kind: "thinking" }), k)).toBeUndefined();
  });
});
