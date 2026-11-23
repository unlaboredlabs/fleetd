import { describe, expect, it } from "vitest";
import { botOf } from "./botState";
import { leadLaneId, tryAgainNow } from "./desktop";
import { initial, reduce, type State } from "./store";
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
    // Its reply lands and its lead works on: the bot leaves the reply's place, and the turn line says what it does.
    const landed = (activity: object) =>
      ({
        ...(at(true, activity) as object),
        chats: { [k]: { messages: [{ author: "human", state: "final" }, { author: "lead", state: "final" }] } },
        sends: {},
      }) as never;
    expect(wakeIn(landed({ kind: "read", path: "a.ts" }), k)).toBeUndefined();
    expect(wakeIn(at(true, { kind: "thinking" }), k)).toBeUndefined();
    // Its turn over, the next one starts warm.
    expect(wakeIn(at(false), k)).toBeUndefined();
    expect(wakeIn(at(true, { kind: "thinking" }), k)).toBeUndefined();
  });

  it("counts a wake from the person's message at the earliest, as the desktop's", () => {
    const k = "devbox/w3";
    const r = { machineId: "devbox", projectId: "w3" };
    const old = "2026-11-22T10:00:00.000Z";
    const sent = "2026-11-22T10:42:00.000Z";
    const s = {
      chatStates: { [k]: { projectRef: r, needsYou: false, leadWorking: true, lastSeq: 1 } },
      leadActivity: { [leadLaneId(r)]: { kind: "starting", text: "Starting its computer", step: "box", startedAt: old } },
      chats: { [k]: { messages: [{ author: "human", state: "final", createdAt: sent }] } },
      sends: {},
    } as never;
    expect(wakeIn(s, k)).toEqual({ phase: "waking", step: "box", since: Date.parse(sent) });
  });

  it("Try again that starts nothing says why, a call that throws included, as the desktop's", async () => {
    expect(await tryAgainNow(() => Promise.resolve({ ok: true, output: { started: false, next: "Your team is out of credits." } }))).toBe("Your team is out of credits.");
    expect(await tryAgainNow(() => Promise.resolve({ ok: true, output: { started: false } }))).toBe("Nothing to retry");
    expect(await tryAgainNow(() => Promise.resolve({ ok: false, error: { message: "The hub isn't connected." } }))).toBe("Couldn’t try again: The hub isn't connected");
    expect(await tryAgainNow(() => Promise.reject(new Error("timeout")))).toBe("Couldn’t try again: timeout");
    expect(await tryAgainNow(() => Promise.resolve({ ok: true, output: { started: true } }))).toBeUndefined();
  });

  it("times a wake on the hub's clock: the live frames' offset, the largest since the last full one", () => {
    const at = Date.parse("2026-11-22T10:00:00.000Z");
    const frame = (s: State, full: boolean, hubMs: number, nowMs: number): State =>
      reduce(s, { t: "frame", frame: { t: "live", frame: { at: new Date(hubMs).toISOString(), full, lanes: [] } }, nowMs });
    // A device 5 s behind the hub, each frame some ms on its way.
    let s = frame(initial({ phase: "live", hub: "http://devbox:4790", protocol: 1 }), true, at, at - 5_000 + 40);
    expect(s.skewMs).toBe(4_960);
    s = frame(s, false, at + 1_000, at - 4_000 + 10);
    expect(s.skewMs).toBe(4_990);
    s = frame(s, false, at + 2_000, at - 3_000 + 200);
    expect(s.skewMs).toBe(4_990);
    // A full frame starts over.
    s = frame(s, true, at + 3_000, at - 2_000 + 300);
    expect(s.skewMs).toBe(4_700);
  });

  // W852: the bot under your message on every turn, not only a cloud bot's waking one.
  it("stands under your message from the send, on any turn, until the reply or a turn that ends without one", () => {
    const k = "devbox/w4";
    const r = { machineId: "devbox", projectId: "w4" };
    const asked = "2026-11-22T10:00:00.000Z";
    const t0 = Date.parse(asked);
    const ask = { messageId: "m1", author: "human", state: "final", createdAt: asked };
    let s = { ...initial({ phase: "live", hub: "http://devbox:4790", protocol: 1 }) } as State;
    s = { ...s, chatStates: { [k]: { projectRef: r, needsYou: false, leadWorking: false, lastSeq: 1 } }, chats: { [k]: { messages: [ask], leadWaiting: {} } } } as never;
    // In, and the lead not started yet: the dots at once.
    expect(wakeIn(s, k, false, t0 + 200)).toEqual({ phase: "received", since: t0 });
    // Long past with no start: nothing.
    expect(wakeIn(s, k, false, t0 + 11 * 60_000)).toBeUndefined();
    // Not on the hub: nothing it can know.
    expect(wakeIn({ ...s, hub: { phase: "connecting", hub: "", attempt: 1 } } as never, k, false, t0 + 200)).toBeUndefined();
    // Why the lead doesn't have it, in its first sentence.
    const held = { ...s, chats: { [k]: { messages: [ask], leadWaiting: { m1: "devbox is offline: its node isn't connected. It goes in when devbox is back." } } } } as never;
    expect(wakeIn(held, k, false, t0 + 200)).toEqual({ phase: "held", reason: "devbox is offline: its node isn't connected." });
    // The lead works on it, an awake bot's turn: thinking, with the dots.
    const event = (leadWorking: boolean, at: string) =>
      ({ t: "frame", frame: { t: "event", event: { seq: 2, at, type: "chat.waiting", summary: "", data: { projectRef: r, needsYou: false, leadWorking, lastSeq: 1 } } }, nowMs: t0 }) as never;
    s = reduce(s, event(true, "2026-11-22T10:00:01.000Z"));
    expect(wakeIn(s, k, false, t0 + 1_500)).toEqual({ phase: "thinking" });
    // Its turn ends with no reply (a quiet one): gone, and it stays gone.
    s = reduce(s, event(false, "2026-11-22T10:00:04.000Z"));
    expect(s.turnEnded?.[k]).toBe(t0 + 4_000);
    expect(wakeIn(s, k, false, t0 + 5_000)).toBeUndefined();
  });
});
