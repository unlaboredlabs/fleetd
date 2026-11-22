import { describe, expect, test } from "vitest";
import { botStateOf } from "./bot";
import type { Activity } from "./contracts";
import { ColdTurns, replied, SLOW_MS, tryAgainLabel, wakeOf, wakePose, wakeShown, wakeWords, type Wake, type WakeIn } from "./wake";

const T = Date.parse("2026-11-22T10:00:00.000Z");
const iso = (ms: number) => new Date(T + ms).toISOString();
const starting = (over: Partial<Extract<Activity, { kind: "starting" }>> = {}): Activity => ({ kind: "starting", text: "Starting its computer at boat.dev", ...over });
const at = (over: Partial<WakeIn>): WakeIn => ({ asleep: false, working: false, activity: undefined, cold: false, writing: false, ...over });
/** The wait of `over`, which the test expects there to be. */
const some = (over: Partial<WakeIn>): Wake => {
  const w = wakeOf(at(over));
  if (w === undefined) throw new Error("no wait");
  return w;
};

describe("a cloud bot waking", () => {
  test("asleep before you write, then waking at its computer's steps", () => {
    expect(wakeOf(at({ asleep: true }))).toEqual({ phase: "asleep" });
    expect(wakeOf(at({}))).toBeUndefined();
    const box = some({ working: true, activity: starting({ step: "box", startedAt: iso(0) }) });
    expect(box).toEqual({ phase: "waking", step: "box", since: T });
    expect(wakeWords(box, T + 5_000)).toEqual({ words: "Waking up" });
    expect(wakeWords({ phase: "waking", step: "files", since: T }, T + 12_000)).toEqual({ words: "Getting its files" });
    expect(wakeWords({ phase: "waking", step: "session", since: T }, T + 14_500)).toEqual({ words: "Getting ready" });
    // A hub that names no step: it is waking all the same.
    expect(wakeWords(some({ working: true, activity: starting() }), T)).toEqual({ words: "Waking up" });
  });

  test("past 30 s it says it is still waking up, with the time so far, never an estimate", () => {
    const w: Wake = { phase: "waking", step: "box", since: T };
    expect(wakeWords(w, T + SLOW_MS - 1)).toEqual({ words: "Waking up" });
    expect(wakeWords(w, T + 33_400)).toEqual({ words: "Still waking up", count: "33s" });
    expect(wakeWords(w, T + 65_000)).toEqual({ words: "Still waking up", count: "1m 05s" });
  });

  test("a failed try says one plain reason, and Try again counts down to its own retry", () => {
    const w = some({ working: true, activity: starting({ step: "box", failed: { reason: "no computer was free", retryAt: iso(10_000) } }) });
    expect(w).toEqual({ phase: "failed", reason: "no computer was free", retryAt: T + 10_000 });
    expect(wakeWords(w, T)).toEqual({ words: "Couldn’t wake up. No computer was free." });
    if (w.phase !== "failed") throw new Error("not failed");
    expect(tryAgainLabel(w, T + 1_200)).toBe("Try again · 9s");
    expect(tryAgainLabel(w, T + 10_000)).toBe("Try again");
    // A billing hold has no retry of its own.
    expect(tryAgainLabel({ phase: "failed", reason: "Your team is out of credits.", retryAt: undefined }, T)).toBe("Try again");
    expect(wakeWords({ phase: "failed", reason: "Your team is out of credits.", retryAt: undefined }, T)).toEqual({ words: "Couldn’t wake up. Your team is out of credits." });
  });

  test("after the start, it stays in the reply's place through the thinking and the first words of a cold turn only", () => {
    expect(wakeOf(at({ working: true, cold: true, activity: { kind: "thinking" } }))).toEqual({ phase: "thinking" });
    expect(wakeOf(at({ working: true, cold: true, activity: { kind: "read", path: "a.ts" } }))).toEqual({ phase: "working" });
    expect(wakeOf(at({ working: true, cold: true, writing: true }))).toEqual({ phase: "writing" });
    // A turn of an awake bot: nothing new.
    expect(wakeOf(at({ working: true, activity: { kind: "thinking" } }))).toBeUndefined();
    expect(wakeShown({ phase: "asleep" })).toBe(false);
    expect(wakeShown({ phase: "writing" })).toBe(true);
  });

  test("the bot arrives asleep, stirs, opens its eyes for its files, then takes the lead's looks", () => {
    const box: Wake = { phase: "waking", step: "box", since: T };
    expect(wakePose(box, false)).toBe("asleep");
    expect(wakePose(box, true)).toBe("waking");
    expect(wakePose({ phase: "waking", step: "files", since: T }, true)).toBe("idle");
    expect(wakePose({ phase: "thinking" }, true)).toBe("thinking");
    expect(wakePose({ phase: "writing" }, true)).toBe("working");
    expect(wakePose({ phase: "failed", reason: "x", retryAt: undefined }, true)).toBe("error");
  });

  test("a turn is cold from its start until its lead stops", () => {
    const cold = new ColdTurns();
    expect(cold.see("a", true, { kind: "thinking" })).toBe(false);
    expect(cold.see("a", false, undefined)).toBe(false);
    expect(cold.see("a", true, starting())).toBe(true);
    expect(cold.see("a", true, { kind: "writing" })).toBe(true);
    expect(cold.see("b", true, { kind: "thinking" })).toBe(false);
    expect(cold.see("a", false, undefined)).toBe(false);
    expect(cold.see("a", true, { kind: "thinking" })).toBe(false);
  });

  test("a turn stops being cold once its reply lands, though its lead works on", () => {
    const cold = new ColdTurns();
    expect(cold.see("a", true, starting())).toBe(true);
    expect(cold.see("a", true, { kind: "writing" }, false)).toBe(true);
    // The reply is whole; the lead reads a file and briefs an agent after it.
    expect(cold.see("a", true, { kind: "read", path: "a.ts" }, true)).toBe(false);
    expect(cold.see("a", true, { kind: "tool", name: "brief", server: "fleetd" }, false)).toBe(false);
    expect(wakeOf(at({ working: true, cold: false, activity: { kind: "read", path: "a.ts" } }))).toBeUndefined();
    // A start, even after a reply, makes it cold again.
    expect(cold.see("a", true, starting(), true)).toBe(true);
  });

  test("a reply has landed when the chat's newest message is the lead's, whole", () => {
    expect(replied(undefined)).toBe(false);
    expect(replied([{ author: "human", state: "final" }])).toBe(false);
    expect(replied([{ author: "human", state: "final" }, { author: "lead", state: "streaming" }])).toBe(false);
    expect(replied([{ author: "human", state: "final" }, { author: "lead", state: "final" }])).toBe(true);
  });

  test("a bot sleeps with its computer and wakes while it starts, in every list", () => {
    const none = { needs: false, blocked: false, running: 0, doing: undefined, done: false };
    expect(botStateOf({ ...none, asleep: true })).toBe("asleep");
    expect(botStateOf({ ...none, asleep: true, done: true })).toBe("done");
    expect(botStateOf({ ...none, asleep: true, needs: true })).toBe("needs");
    expect(botStateOf({ ...none, start: "waking", doing: "Starting its computer" })).toBe("waking");
    expect(botStateOf({ ...none, start: "failed", doing: "Starting its computer" })).toBe("error");
  });
});
