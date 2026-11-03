// A long lead reply streaming in (UX-1 [23]): storefront's lead writes a plan of headings, lists, code, a table and a
// quote, in many small deltas over the live chat feed, and is still writing at the last one. The chat shows the typing
// bubble for it until it is final; this is the screen that must stay right while the deltas land.
import { fromLines, firstProject, streamReply, writeChat } from "../kit/chat.ts";
import { at } from "../kit/ids.ts";
import { arr, obj } from "../kit/stress.ts";
import { isObject, type JsonObject } from "../kit/json.ts";
import { QUESTION } from "../kit/chatText.ts";
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";

const REPLY = `Here's the plan for the receipts, step by step. Two agents are already on the first part.

## 1. Dates and totals

The receipt shows the date and the total on one line, and on a narrow screen the date wraps under the total. The writer is moving them onto two lines, with the total right-aligned so the amounts line up.

- en-GB: 19 Oct 2026
- de-DE: 19.10.2026
- ja-JP: 2026/10/19

Totals round the half cent the way the payment provider does, so a receipt never disagrees with the bank statement:

\`\`\`ts
export function roundTotal(cents: number): number {
  const whole = Math.floor(cents);
  const frac = cents - whole;

  // Half a cent goes to the even neighbour, as the provider rounds.
  if (frac === 0.5) return whole % 2 === 0 ? whole : whole + 1;
  return Math.round(cents);
}
\`\`\`

## 2. Discounts

Discounts use the same rounding. Today they round each line first and then add, which can be a cent off on a long order. After the change:

| Order | Before | After |
| --- | --- | --- |
| 3 × 0.335 | 1.02 | 1.01 |
| 7 × 1.125 | 7.91 | 7.88 |
| 12 × 0.005 | 0.12 | 0.06 |

1. Add the line amounts unrounded.

2. Round the sum once, with \`roundTotal\`.

3. Show each line rounded for display only.

> The reviewer asked whether old receipts change. They don't: a receipt keeps the total it was issued with, and only new orders use the new rounding.

## 3. Tests

QA runs the receipt tests in all three locales, on a phone-sized window and on a wide one, and checks the PDF export against the screen. If any of them fails I'll say which and what it saw.

Once both PRs are green they go in one after the other, dates first. Nothing needs you yet. I'll write again when the first PR is up, and when QA has the screenshots for you to look at`;

/** The reply in deltas of about the size a model streams: a few words each. */
const deltas = (text: string, size: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

const SO_FAR = 220;

/**
 * How many messages arrive in stream-in-long's chat before the reply: with its first page, a long day's chat (a chat
 * keeps up to 2,000). Enough that a cost per message held drops frames even on a fast CI runner.
 */
const ARRIVALS = 1_500;
/**
 * When stream-in-long's messages start arriving, ms after the window subscribes: once its chat has opened (its first
 * page read) on a slow runner, so they arrive live into it.
 */
export const STREAM_IN_LONG_ARRIVE_MS = 2_000;
/** When its reply starts streaming: after the arrivals have landed... */
export const STREAM_IN_LONG_FROM_MS = 8_000;
/** ...and when its last delta lands: perf/run.ts's streaming round must end before. */
export const STREAM_IN_LONG_TO_MS = 23_000;
/** The node's rate: it sends a session's streamed text at most every 100 ms (DELTA_EVERY in node/sessions). */
const NODE_DELTA_MS = 100;

/**
 * chat-long's chat with ARRIVALS more messages arriving live, as over a long day, then a reply from the lead streaming
 * in at the node's rate: perf/run.ts's streaming round. Each delta rebuilds the chat's rows, so their cost grows with
 * what the chat holds; a date formatter made per message once took this under 20 fps.
 */
const streamIntoLong = (f: Fixture): Fixture => {
  const ref = firstProject(f);
  const projectRef = { ...ref };
  const newest = arr(obj(f.output("chat_history", { projectRef }))["messages"]).filter(isObject);
  const texts = newest.map((m) => m["text"]).filter((t): t is string => typeof t === "string" && t !== "");
  const last = Number(newest.at(-1)?.["seq"]);
  if (!Number.isFinite(last) || texts.length === 0) throw new Error(`${f.name}: storefront's chat has no newest page`);
  // Past every event the fixture has, or the app takes it for one it has seen.
  let event = Math.max(Number(f.snapshot?.["cursor"] ?? 0), ...f.events.map((e) => Number(e["seq"] ?? 0))) + 1;
  const arrive = (ms: number, message: JsonObject) =>
    f.later(ms, "event", {
      seq: event++,
      at: message["createdAt"] ?? f.now,
      type: "chat.message",
      summary: "The lead in the chat",
      machineId: ref.machineId,
      projectId: ref.projectId,
      data: { projectRef, messageId: message["messageId"] ?? "", seq: message["seq"] ?? 0, author: message["author"] ?? "lead", state: message["state"] ?? "final", message },
    });
  for (let i = 0; i < ARRIVALS; i++) {
    const seq = last + 1 + i;
    const message: JsonObject = { messageId: `m${String(seq)}`, projectRef, seq, author: i % 3 === 0 ? "human" : "lead", text: texts[i % texts.length] ?? "", attachments: [], createdAt: at(f.now, -15_000 + i * 20), state: "final" };
    arrive(STREAM_IN_LONG_ARRIVE_MS + i * 2, message);
  }
  const seq = last + 1 + ARRIVALS;
  const createdAt = at(f.now, -2_000);
  const reply: JsonObject = { messageId: `m${String(seq)}`, projectRef, seq, author: "lead", text: "", attachments: [], createdAt, updatedAt: createdAt, state: "streaming" };
  arrive(STREAM_IN_LONG_FROM_MS - NODE_DELTA_MS, reply);
  const parts = deltas(REPLY.repeat(4), 40).slice(0, (STREAM_IN_LONG_TO_MS - STREAM_IN_LONG_FROM_MS) / NODE_DELTA_MS + 1);
  let offset = 0;
  parts.forEach((append, i) => {
    f.later(STREAM_IN_LONG_FROM_MS + i * NODE_DELTA_MS, "chat_delta", { projectRef: { ...ref }, messageId: reply["messageId"] ?? "", seq, offset, append });
    offset += append.length;
  });
  return f;
};

export default defineGroup({
  fixtures: (base) => {
    const f = Fixture.from(base("chat-streaming"), "stream-long", "A long lead reply streams in over the live chat feed in small deltas, headings, lists, code, a table and a quote, and is still unfinished at the last one.");
    f.timeline = f.timeline.filter((t) => t.kind !== "chat_delta");
    f.settleMs = undefined;
    const ref = firstProject(f);
    writeChat(f, ref, [...fromLines(QUESTION), { author: "human", text: "sounds good, go ahead and tell me the plan" }, { author: "lead", text: REPLY.slice(0, SO_FAR), state: "streaming" }], { leadWorking: true });
    // W42's motion: the lead writing a moment, then its reply final, its bubbles rising in one after another.
    const r = Fixture.from(base("chat-streaming"), "stream-reply", "The lead writes for a moment, then its reply arrives whole: the typing bubble gives way to its bubbles.");
    r.timeline = r.timeline.filter((t) => t.kind !== "chat_delta");
    const rref = firstProject(r);
    writeChat(r, rref, [...fromLines(QUESTION), { author: "human", text: "sounds good, go ahead and tell me the plan" }, { author: "lead", text: "", state: "streaming" }], { leadWorking: true });
    const last = arr(obj(r.output("chat_history", { projectRef: { ...rref } }))["messages"]).filter(isObject).at(-1) ?? {};
    // Past every event the fixture has, timed ones included, or the app takes it for one it has seen.
    const seq =
      Math.max(
        Number(r.snapshot?.["cursor"] ?? 0),
        ...r.events.map((e) => Number(e["seq"] ?? 0)),
        ...r.timeline.filter((x) => x.kind === "event").map((x) => Number(x.payload["seq"] ?? 0)),
      ) + 1;
    const text = "Here's the plan.\n\nTwo writers start now: one on the receipt dates, one on the totals.\n\nQA checks both on a phone-sized window once the PRs are up. Nothing needs you yet.";
    r.later(1400, "event", {
      seq,
      at: at(r.now, 1400),
      type: "chat.message",
      summary: "The lead in the chat",
      machineId: rref.machineId,
      projectId: rref.projectId,
      data: { projectRef: { ...rref }, messageId: last["messageId"] ?? "m1", seq: last["seq"] ?? 1, author: "lead", state: "final", message: { ...last, text, state: "final", updatedAt: at(r.now, 1400) } },
    });
    r.settleAt(2000);
    const long = streamIntoLong(
      Fixture.from(base("chat-long"), "stream-in-long", "storefront's long chat with 1,500 more messages arriving, as over a long day, then the lead's reply streaming in at the node's rate (perf/run.ts)."),
    );
    return [streamReply(f, ref, deltas(REPLY.slice(SO_FAR), 24), 25), r, long];
  },
});
