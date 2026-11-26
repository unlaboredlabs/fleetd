import { describe, expect, it } from "vitest";
import { botOf } from "./botState";
import { leadLaneId, tryAgainNow } from "./desktop";
import { initial, reduce, type State } from "./store";
import { staleAt, wakeIn } from "./wake";

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
    const failed = { ...(chat({ leadWorking: true }) as object), leadActivity: lane({ kind: "starting", text: "…", step: "box", failed: { reason: "No computer was free", retryAt: "2031-05-06T07:09:00.000Z" } }) } as never;
    expect(botOf(failed, KEY)).toBe("error");
    // A start the team's billing holds has no retry of its own: the bot rests, never at work while nothing runs.
    const held = { ...(chat({ leadWorking: true }) as object), leadActivity: lane({ kind: "starting", text: "…", step: "box", failed: { reason: "This team reached its spend cap" } }) } as never;
    expect(botOf(held, KEY)).toBe("idle");
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

  // W868 (F1486): "The lead restarted on neon." under the message, then a server not loaded as it started, and the
  // bot was gone for the 40 s until the reply.
  it("stays under your message through a lead's restart and its lines, until the reply", () => {
    const k = "devbox/w7";
    const r = { machineId: "devbox", projectId: "w7" };
    const asked = "2026-11-22T10:00:00.000Z";
    const t0 = Date.parse(asked);
    const line = (id: string, createdAt: string) => ({ messageId: id, author: "system", state: "final", createdAt });
    const ask = { messageId: "m1", author: "human", state: "final", createdAt: asked };
    const messages = [ask, line("m2", "2026-11-22T10:00:02.000Z")];
    const state = (over: object, more: object[] = []) =>
      ({ ...initial({ phase: "live", hub: "http://devbox:4790", protocol: 1 }), chatStates: { [k]: { projectRef: r, needsYou: false, leadWorking: false, lastSeq: 1, leadIdleAt: "1970-01-01T00:00:00.000Z", ...over } }, chats: { [k]: { messages: [...messages, ...more], leadWaiting: {} } } }) as never;
    // Its computer asleep while the new session starts: it wakes under your message.
    expect(wakeIn(state({ leadAsleep: true }), k, false, t0 + 15_000)).toEqual({ phase: "waking", step: undefined, since: t0 });
    // An awake one's new session not at work yet: the dots.
    expect(wakeIn(state({}), k, false, t0 + 15_000)).toEqual({ phase: "received", since: t0 });
    // At work on it, another line of fleetd's own beside it: thinking.
    expect(wakeIn(state({ leadWorking: true, leadIdleAt: undefined }, [line("m3", "2026-11-22T10:00:30.000Z")]), k, false, t0 + 31_000)).toEqual({ phase: "thinking" });
    // The reply: gone.
    const reply = { messageId: "m4", author: "lead", state: "final", createdAt: "2026-11-22T10:00:41.000Z" };
    expect(wakeIn(state({ leadWorking: true, leadIdleAt: undefined }, [reply]), k, false, t0 + 42_000)).toBeUndefined();
  });

  // The review of #2131: the phone locked through a quiet turn, the snapshot it reopens with says when the turn ended.
  it("reopened after a quiet turn, by the hub's leadIdleAt: no bot; a follow-up turn on it has the bot again", () => {
    const k = "devbox/w5";
    const r = { machineId: "devbox", projectId: "w5" };
    const asked = "2026-11-22T10:00:00.000Z";
    const t0 = Date.parse(asked);
    const base = { ...initial({ phase: "live", hub: "http://devbox:4790", protocol: 1 }), chats: { [k]: { messages: [{ messageId: "m1", author: "human", state: "final", createdAt: asked }], leadWaiting: {} } } };
    const idle = { ...base, chatStates: { [k]: { projectRef: r, needsYou: false, leadWorking: false, lastSeq: 1, leadIdleAt: "2026-11-22T10:00:04.000Z" } } } as never;
    expect(wakeIn(idle, k, false, t0 + 60_000)).toBeUndefined();
    const followUp = { ...base, chatStates: { [k]: { projectRef: r, needsYou: false, leadWorking: true, lastSeq: 1 } } } as never;
    expect(wakeIn(followUp, k, false, t0 + 60_000)).toEqual({ phase: "thinking" });
    // Idle since before it, ten minutes on: the lead didn't start, and the bot says so; drawn again on time (staleAt).
    const never = { ...base, chatStates: { [k]: { projectRef: r, needsYou: false, leadWorking: false, lastSeq: 1, leadIdleAt: "2026-11-22T09:00:00.000Z" } } } as never;
    expect(staleAt(never, k)).toBe(t0 + 10 * 60_000);
    expect(wakeIn(never, k, false, t0 + 60_000)).toEqual({ phase: "received", since: t0 });
    expect(wakeIn(never, k, false, t0 + 10 * 60_000)).toEqual({ phase: "unstarted" });
  });

  it("says why the bot is blocked, as Status last read it (its usage paused), in place of the dots, and lets go as it lifts", () => {
    const k = "devbox/w6";
    const r = { machineId: "devbox", projectId: "w6" };
    const asked = "2026-11-22T10:00:00.000Z";
    let s = { ...initial({ phase: "live", hub: "http://devbox:4790", protocol: 1 }), chatStates: { [k]: { projectRef: r, needsYou: false, leadWorking: false, lastSeq: 1 } }, chats: { [k]: { messages: [{ messageId: "m1", author: "human", state: "final", createdAt: asked }], leadWaiting: {} } } } as never as State;
    const row = (state: string, blockedReason?: string) => ({ projectRef: r, title: "w6", asOf: asked, agentsRunning: 0, state, ...(blockedReason === undefined ? {} : { blockedReason }) }) as never;
    s = reduce(s, { t: "status", rows: [row("blocked", "usage paused on devbox until 15:00")] });
    expect(wakeIn(s, k, false, Date.parse(asked) + 1_000)).toEqual({ phase: "held", reason: "The lead can’t start now: usage paused on devbox until 15:00." });
    // Status read again as the pause lifts (a usage.* event): the reason goes, and the bot waits for the lead again.
    s = reduce(s, { t: "status", rows: [row("working")] });
    expect(wakeIn(s, k, false, Date.parse(asked) + 1_000)).toEqual({ phase: "received", since: Date.parse(asked) });
  });

  // S9: with its machine offline mid-turn, the bot's typing dots kept moving beside "thinking".
  it("says its machine is offline and the lead carries on, in place of the dots, and the lead's own state once it is back", () => {
    const k = "devbox/w7";
    const r = { machineId: "devbox", projectId: "w7" };
    const asked = "2026-11-22T10:00:00.000Z";
    const machine = (status: string) => [{ machineId: "devbox", name: "devbox", status, lastSeenAt: asked, nodeVersion: "1" }] as never;
    const s = {
      ...initial({ phase: "live", hub: "http://devbox:4790", protocol: 1 }),
      chatStates: { [k]: { projectRef: r, needsYou: false, leadWorking: true, lastSeq: 1 } },
      chats: { [k]: { messages: [{ messageId: "m1", author: "human", state: "final", createdAt: asked }], leadWaiting: {} } },
      leadActivity: { [leadLaneId(r)]: { activity: { kind: "thinking" }, since: asked } },
    } as never as State;
    const at = Date.parse(asked) + 1_000;
    expect(wakeIn({ ...s, machines: machine("offline") }, k, false, at)).toEqual({ phase: "held", reason: "Its machine is offline. The lead carries on when it’s back." });
    // Status's reason, as the workspace said it, the lead's way: never "can't start" for a lead mid-turn.
    expect(wakeIn({ ...s, machines: machine("offline"), blocked: { [k]: "devbox is offline" } } as never, k, false, at)).toEqual({ phase: "held", reason: "devbox is offline. The lead carries on when it’s back." });
    expect(wakeIn({ ...s, machines: machine("online") }, k, false, at)?.phase).toBe("working");
  });
});
