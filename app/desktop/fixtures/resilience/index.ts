// Sequences that blanked the window: the lead chat on chat-streaming while the hub restarts, while a lead turn adds
// a burst of plan items and streams a new reply, and while the link drops mid-reply; and the bot on screen removed
// while its chat is open, which says so (W890). QA's resilience entries
// (qa/registry.ts) fail when any of them leaves the window blank or an error card up.
import { Fixture, HUB, PROTOCOL } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at } from "../kit/ids.ts";
import { firstProject, type Ref } from "../kit/chat.ts";
import { arr, obj } from "../kit/stress.ts";
import { asText, isObject, type JsonObject, type JsonValue } from "../kit/json.ts";

/** chat-streaming's deltas run until here; each scenario starts after them unless it means to cut them off. */
const STREAMED_BY = 2400;

const REPLY = [
  "Picked it up. Splitting the checkout fix into three items:",
  " the rounding in cart totals,",
  " the en-GB and de-DE locale tests,",
  " and the receipt layout on narrow screens.",
  " Writers start on the first two now;",
  " the third waits for the reviews.",
];

/** The newest event number the fixture has used, timed frames included. */
const lastSeq = (f: Fixture): number =>
  Math.max(
    Number(f.snapshot?.["cursor"] ?? 0),
    ...f.events.map((e) => Number(e["seq"] ?? 0)),
    ...f.timeline.filter((t) => t.kind === "event").map((t) => Number(t.payload["seq"] ?? 0)),
  );

/** The project's newest message in its latest history page. */
const newest = (f: Fixture, ref: Ref): JsonObject => {
  const page = obj(f.output("chat_history", { projectRef: { ...ref } }));
  const last = arr(page["messages"]).filter(isObject).at(-1);
  if (last === undefined) throw new Error(`${f.name}: the chat has no messages`);
  return last;
};

const event = (f: Fixture, ref: Ref, seq: number, ms: number, type: string, summary: string, data: JsonObject): JsonObject => ({
  seq,
  at: at(f.now, ms),
  type,
  summary,
  machineId: ref.machineId,
  projectId: ref.projectId,
  data,
});

const chatMessage = (f: Fixture, ref: Ref, seq: number, ms: number, message: JsonObject): JsonObject =>
  event(f, ref, seq, ms, "chat.message", "The lead in the chat", {
    projectRef: { ...ref },
    messageId: asText(message["messageId"]),
    seq: Number(message["seq"]),
    author: "lead",
    state: asText(message["state"]),
    message,
  });

/**
 * A new lead reply streams in: its deltas from `fromMs`, every `everyMs`, and its chat.message event (state
 * streaming) only `announceAfter` deltas in, as it reaches the app behind a burst of other events.
 */
const newReply = (f: Fixture, ref: Ref, seq: number, fromMs: number, everyMs: number, announceAfter: number): void => {
  const prior = newest(f, ref);
  const messageId = `m${String(Number(prior["seq"]) + 1)}`;
  const message = { messageId, projectRef: { ...ref }, seq: Number(prior["seq"]) + 1, author: "lead", attachments: [], createdAt: at(f.now, fromMs) };
  let offset = 0;
  REPLY.forEach((append, i) => {
    const ms = fromMs + i * everyMs;
    if (i === announceAfter) {
      const text = REPLY.slice(0, i).join("");
      f.later(ms - 1, "event", chatMessage(f, ref, ++seq, ms, { ...message, text, state: "streaming", updatedAt: at(f.now, ms) }));
    }
    f.later(ms, "chat_delta", { projectRef: { ...ref }, messageId, seq: message.seq, offset, append });
    offset += append.length;
  });
};

/** `n` plan.changed events, `everyMs` apart from `fromMs`: a lead adding plan items one by one. */
const planBurst = (f: Fixture, ref: Ref, seq: number, fromMs: number, n: number, everyMs: number): number => {
  for (let i = 0; i < n; i++) {
    const ms = fromMs + i * everyMs;
    f.later(
      ms,
      "event",
      event(f, ref, ++seq, ms, "plan.changed", `+1 item: checkout step ${String(i + 1)}`, {
        at: at(f.now, ms),
        by: "hub",
        deltaItems: 1,
        deltaSize: 1,
        kind: "scope",
        milestoneId: "M1",
        note: `+1 item: checkout step ${String(i + 1)}`,
        workstreamId: "W1",
      }),
    );
  }
  return seq;
};

/** The hub goes away at `fromMs` and is back `downMs` later with a fresh snapshot, as after a restart. */
const restart = (f: Fixture, seq: number, fromMs: number, downMs: number): number => {
  f.later(fromMs, "state", { phase: "retrying", hub: HUB, reason: "The workspace closed the connection", retryAt: Date.parse(at(f.now, fromMs + downMs)) });
  f.later(fromMs + downMs - 200, "state", { phase: "connecting", hub: HUB, attempt: 1 });
  f.later(fromMs + downMs, "state", { phase: "live", hub: HUB, protocol: PROTOCOL });
  const cursor = seq + 1;
  f.later(fromMs + downMs, "snapshot", { ...f.snapshot, cursor });
  return cursor;
};

export default defineGroup({
  fixtures: (base) => {
    const scenario = (what: string, note: string, build: (f: Fixture, ref: Ref, seq: number) => void): Fixture => {
      const f = Fixture.from(base("chat-streaming"), `resilience-${what}`, note);
      build(f, firstProject(f), lastSeq(f));
      // Shot once every frame is in, and the reads they set off have landed.
      return f.settleAt(Math.max(...f.timeline.map((t) => t.ms)) + 500);
    };
    return [
      scenario("burst", "A lead turn adds 150 plan items while a new reply streams in, its deltas ahead of its chat.message event.", (f, ref, seq) => {
        newReply(f, ref, planBurst(f, ref, seq, STREAMED_BY + 100, 150, 4), STREAMED_BY + 150, 120, 5);
      }),
      scenario("hub-restart", "The workspace restarts mid-chat: the link drops, comes back with a fresh snapshot, and the lead goes on with a new reply.", (f, ref, seq) => {
        newReply(f, ref, restart(f, seq, STREAMED_BY, 1200), STREAMED_BY + 1600, 120, 3);
      }),
      scenario("reconnect-streaming", "The link drops while the lead's reply streams: its deltas go on past the text the reread history holds.", (f, _ref, seq) => {
        restart(f, seq, 700, 500);
      }),
      scenario("bot-removed", "The bot on screen is removed while its chat is open: the next snapshot no longer lists it (W890).", (f, ref, seq) => {
        const gone = (p: JsonValue | undefined) => !(isObject(p) && p["machineId"] === ref.machineId && p["projectId"] === ref.projectId);
        // The newest bot, so it is the one the app opens on (its home) and has open when it goes.
        const projects = arr(f.snapshot?.["projects"]).map((p) => (isObject(p) && !gone(p) ? { ...p, lastActivityAt: at(f.now, 0) } : p));
        if (f.snapshot !== undefined) f.snapshot = { ...f.snapshot, projects };
        const chats = arr(f.snapshot?.["chats"]).filter((c) => !isObject(c) || gone(c["projectRef"]));
        f.later(STREAMED_BY + 300, "snapshot", { ...f.snapshot, cursor: seq + 1, projects: arr(f.snapshot?.["projects"]).filter(gone), chats });
      }),
    ];
  },
});
