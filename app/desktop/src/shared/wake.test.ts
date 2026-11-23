import { describe, expect, test } from "vitest";
import { botStateOf } from "./bot";
import type { Activity } from "./contracts";
import {
  askedAt,
  ColdTurns,
  heldWords,
  replied,
  SLOW_MS,
  START_SLOW_MS,
  tryAgainNote,
  tryAgainNow,
  tryAgainLabel,
  waitingFor,
  endedAt,
  wakeDots,
  wakeOf,
  wakePose,
  wakeShown,
  wakeWords,
  type Wake,
  type WakeIn,
} from "./wake";

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

  // W836: right after a message, "Still waking up 42m 37s", from a start the hub kept from long before it.
  test("a wake counts from the person's message at the earliest, never from an older start", () => {
    const asked = askedAt([
      { author: "human", createdAt: iso(-60_000) },
      { author: "lead", createdAt: iso(-50_000) },
      { author: "human", createdAt: iso(42 * 60_000) },
    ]);
    expect(asked).toBe(T + 42 * 60_000);
    const w = some({ working: true, activity: starting({ step: "box", startedAt: iso(0) }), asked });
    expect(w).toEqual({ phase: "waking", step: "box", since: T + 42 * 60_000 });
    expect(wakeWords(w, T + 42 * 60_000 + 5_000)).toEqual({ words: "Waking up" });
    // A start that began after the message counts from its own start.
    expect(some({ working: true, activity: starting({ startedAt: iso(5_000) }), asked: T })).toMatchObject({ since: T + 5_000 });
    expect(askedAt([{ author: "lead", createdAt: iso(0) }])).toBeUndefined();
    expect(askedAt(undefined)).toBeUndefined();
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

  test("Try again that starts nothing says why: the hub's word, nothing waiting, or why the call failed", async () => {
    expect(tryAgainNote({ ok: true, output: { started: true } })).toBeUndefined();
    expect(tryAgainNote({ ok: true, output: { started: false } })).toBe("Nothing to retry");
    expect(tryAgainNote({ ok: true, output: { started: false, next: "Your team is out of credits. It goes on by itself once that is done." } })).toBe(
      "Your team is out of credits. It goes on by itself once that is done.",
    );
    expect(tryAgainNote({ ok: false, error: { message: "The hub didn't answer in time." } })).toBe("Couldn’t try again: The hub didn't answer in time");
    // A call that throws rather than answers says why too.
    expect(await tryAgainNow(() => Promise.reject(new Error("offline")))).toBe("Couldn’t try again: offline");
    expect(await tryAgainNow(() => Promise.resolve({ ok: true, output: { started: true } }))).toBeUndefined();
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

// W852: "all done?" sat beside a dot grid with no sign the bot had started.
describe("the bot in the reply's place on every turn", () => {
  const human = (ms: number) => ({ author: "human", state: "final", createdAt: iso(ms) });
  const lead = (ms: number, state = "final") => ({ author: "lead", state, createdAt: iso(ms) });

  test("from the send, before the hub has it, until the lead's whole reply or fleetd's own line", () => {
    expect(waitingFor([lead(0)], true)).toBe(true);
    expect(waitingFor([lead(0), human(1_000)], false)).toBe(true);
    // An agent's message to the lead answers nothing; the lead's reply streaming is still on its way.
    expect(waitingFor([human(1_000), { author: "agent", state: "final", createdAt: iso(2_000) }], false)).toBe(true);
    expect(waitingFor([human(1_000), lead(2_000, "streaming")], false)).toBe(true);
    expect(waitingFor([human(1_000), lead(2_000)], false)).toBe(false);
    expect(waitingFor([human(1_000), { author: "system", state: "final", createdAt: iso(2_000) }], false)).toBe(false);
    expect(waitingFor([], false)).toBe(false);
    expect(waitingFor(undefined, false)).toBe(false);
  });

  // The review of #2131: a quiet turn that ended while the app was away must not leave the bot waiting.
  test("idle after a turn that ended since the message (a quiet one, by the hub's leadIdleAt): gone, though no stop was seen", () => {
    const asked = T + 1_000;
    expect(endedAt(iso(5_000), undefined)).toBe(T + 5_000);
    expect(endedAt(undefined, T + 3_000)).toBe(T + 3_000);
    expect(endedAt(iso(5_000), T + 7_000)).toBe(T + 7_000);
    expect(endedAt(undefined, undefined)).toBeUndefined();
    expect(wakeOf(at({ waiting: true, asked, endedAt: T + 5_000, idleKnown: true }))).toBeUndefined();
    expect(wakeOf(at({ waiting: true, asked, endedAt: T + 5_000, idleKnown: true, stale: true }))).toBeUndefined();
    // A turn that ended before it doesn't count: the lead hasn't started on it.
    expect(some({ waiting: true, asked, endedAt: T, idleKnown: true })).toEqual({ phase: "received", since: asked });
    // A stale reason from chat_send is over too once a turn had it.
    expect(wakeOf(at({ waiting: true, asked, endedAt: T + 5_000, held: "devbox is offline." }))).toBeUndefined();
  });

  test("the hub's follow-up turn on it, after a quiet one, has the bot and its dots again", () => {
    const asked = T + 1_000;
    expect(some({ working: true, waiting: true, asked, endedAt: T + 5_000, idleKnown: true, activity: { kind: "thinking" } })).toEqual({ phase: "thinking" });
  });

  test("a start that never comes says so, and what to do, never a wait that goes on or ends without a word", () => {
    const unstarted = some({ waiting: true, asked: T, endedAt: T - 60_000, idleKnown: true, stale: true });
    expect(unstarted).toEqual({ phase: "unstarted" });
    expect(wakeDots(unstarted)).toBe(false);
    expect(wakePose(unstarted, true)).toBe("idle");
    expect(wakeWords(unstarted, T)?.words).toMatch(/^The lead didn’t start on this\. Send it again, or press Restart lead/u);
    // A hub that doesn't say when turns end: a turn that ended unseen can't be told from none, so nothing.
    expect(wakeOf(at({ waiting: true, asked: T, stale: true }))).toBeUndefined();
  });

  test("received at once with the typing dots, thinking and working the same way, words only past a slow start", () => {
    const received = some({ waiting: true, asked: T });
    expect(received).toEqual({ phase: "received", since: T });
    expect(wakeShown(received)).toBe(true);
    expect(wakeDots(received)).toBe(true);
    expect(wakePose(received, true)).toBe("thinking");
    expect(wakeWords(received, T + 3_000)).toBeUndefined();
    expect(wakeWords(received, T + START_SLOW_MS + 2_000)).toEqual({ words: "Waiting for the lead to start", count: "12s" });
    // Sent just now, its own time not back yet.
    expect(some({ waiting: true })).toEqual({ phase: "received", since: undefined });
    // A turn of an awake bot answering you: the bot thinks, then works, with the dots, and stays through its first words.
    const thinking = some({ working: true, waiting: true, activity: { kind: "thinking" } });
    expect(thinking).toEqual({ phase: "thinking" });
    expect(wakeDots(thinking)).toBe(true);
    expect(wakeWords(thinking, T)).toBeUndefined();
    expect(wakeDots(some({ working: true, waiting: true, activity: { kind: "edit", path: "a.ts" } }))).toBe(true);
    const writing = some({ working: true, waiting: true, writing: true });
    expect(writing).toEqual({ phase: "writing" });
    expect(wakeDots(writing)).toBe(false);
  });

  test("gone once nothing waits: the reply landed, a quiet turn ended it, or the message is long past", () => {
    expect(wakeOf(at({ working: true, waiting: false, activity: { kind: "thinking" } }))).toBeUndefined();
    expect(wakeOf(at({ waiting: false }))).toBeUndefined();
    expect(wakeOf(at({ waiting: true, stale: true }))).toBeUndefined();
    // A lead at work on a stale ask is still at work on it.
    expect(wakeOf(at({ working: true, waiting: true, stale: true }))).toEqual({ phase: "thinking" });
  });

  test("a bot asleep stirs at once on your message, before the hub's first step", () => {
    const w = some({ asleep: true, waiting: true, asked: T });
    expect(w).toEqual({ phase: "waking", step: undefined, since: T });
    expect(wakeWords(w, T + 1_000)).toEqual({ words: "Waking up" });
  });

  test("what holds the lead up says why in one plain line, in place of the dots", () => {
    expect(heldWords({ leadWaiting: "factory-a is offline: its node isn't connected. It goes in when factory-a is back. Repair it in Settings › Machines." })).toBe(
      "factory-a is offline: its node isn't connected.",
    );
    expect(heldWords({ blocked: "usage limit reached on devbox until 15:00" })).toBe("The lead can’t start now: usage limit reached on devbox until 15:00.");
    expect(heldWords({ blocked: "" })).toBe("The lead can’t start now.");
    expect(heldWords({})).toBeUndefined();
    const held = some({ waiting: true, blocked: "The lead can’t start now: devbox is offline." });
    expect(held).toEqual({ phase: "held", reason: "The lead can’t start now: devbox is offline." });
    expect(wakeDots(held)).toBe(false);
    expect(wakePose(held, true)).toBe("idle");
    expect(wakeWords(held, T)).toEqual({ words: "The lead can’t start now: devbox is offline." });
    // Even long past: it still holds.
    expect(some({ waiting: true, stale: true, blocked: "x" })).toEqual({ phase: "held", reason: "x" });
    // A lead at work is at work, whatever the status said a moment ago.
    expect(some({ working: true, waiting: true, blocked: "x" })).toEqual({ phase: "thinking" });
    // But the hub's word that your message never reached it wins: whatever the lead works on, it isn't that.
    expect(some({ working: true, waiting: true, held: "devbox is offline." })).toEqual({ phase: "held", reason: "devbox is offline." });
  });
});
