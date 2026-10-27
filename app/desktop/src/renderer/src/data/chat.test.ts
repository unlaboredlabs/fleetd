import { describe, expect, it } from "vitest";
import { afterCall, applyDelta, applyHistory, CHAT_KEEP, chatItems, emptyChat, mergeLive, mergeMessages, settleSends, toResend, upsertSend, type ChatSend } from "./chat";
import type { ChatHistoryOutput, ChatMessage } from "./chat-contract";

const ref = { machineId: "devbox", projectId: "storefront" };
const msg = (seq: number, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: `m${seq}`,
  projectRef: ref,
  seq,
  author: "lead",
  state: "final",
  text: `message ${seq}`,
  createdAt: `2026-10-19T10:00:${String(seq % 60).padStart(2, "0")}.000Z`,
  ...patch,
});
const page = (messages: ChatMessage[], moreBefore = false): ChatHistoryOutput => ({
  messages,
  moreBefore,
  moreAfter: false,
  state: { projectRef: ref, needsYou: false, leadWorking: false, lastSeq: messages.at(-1)?.seq ?? 0 },
});
const row = (id: string, patch: Partial<ChatSend> = {}): ChatSend => ({
  clientRequestId: id,
  text: "ship it",
  attachments: [],
  at: "2026-10-19T10:01:00.000Z",
  state: { t: "sending" },
  ...patch,
});
const delta = (messageId: string, offset: number, append: string) => ({ projectRef: ref, messageId, seq: 1, offset, append });
/** When a delta arrives, on the hub's clock. */
const NOW = Date.parse("2026-10-19T10:02:00.000Z");

describe("chat messages", () => {
  it("merge by id in seq order, from any source in any order, and an older copy never wins", () => {
    let chat = applyHistory(emptyChat, page([msg(2), msg(3)], true), "latest");
    const edited = msg(3, { text: "fixed", updatedAt: "2026-10-19T11:00:00.000Z" });
    chat = mergeMessages(chat, [edited, msg(1)]);
    chat = mergeMessages(chat, [msg(3)]);
    expect(chat.messages.map((m) => [m.seq, m.text])).toEqual([
      [1, "message 1"],
      [2, "message 2"],
      [3, "fixed"],
    ]);
  });

  it("pages older history in and keeps the newest CHAT_KEEP", () => {
    let chat = applyHistory(emptyChat, page([msg(100)], true), "latest");
    chat = applyHistory({ ...chat, loadingOlder: true }, page([msg(99)]), "older");
    expect([chat.hasOlder, chat.loadingOlder, chat.messages.length]).toEqual([false, false, 2]);
    chat = mergeMessages(chat, Array.from({ length: CHAT_KEEP + 5 }, (_, i) => msg(1000 + i)));
    expect(chat.messages).toHaveLength(CHAT_KEEP);
    expect(chat.messages[0]?.seq).toBe(1005);
    expect(chat.hasOlder).toBe(true);
  });

  it("pages back past CHAT_KEEP to the very first message, never evicting the newest; live messages still land", () => {
    const run = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));
    let chat = applyHistory(emptyChat, page(run(1001, 3000), true), "latest");
    while (chat.hasOlder) {
      const oldest = chat.messages[0]?.seq ?? 0;
      const from = Math.max(1, oldest - 50);
      chat = applyHistory(chat, page(run(from, oldest - 1), from > 1), "older");
    }
    expect([chat.messages[0]?.seq, chat.messages.at(-1)?.seq, chat.messages.length]).toEqual([1, 3000, 3000]);
    // The window paged back to is kept; a live message lands at the end, the oldest giving way.
    chat = mergeLive(chat, msg(3001));
    expect([chat.messages[0]?.seq, chat.messages.at(-1)?.seq, chat.messages.length, chat.hasOlder]).toEqual([2, 3001, 3000, true]);
  });

  it("streams by offset: a repeat or overlap adds only what's new, a jump past the end is a gap, the final ends it", () => {
    let chat = applyHistory(emptyChat, page([msg(1, { state: "streaming", text: "" })]), "latest");
    chat = applyDelta(chat, delta("m1", 0, "Hel"), NOW);
    chat = applyDelta(chat, delta("m1", 3, "lo"), NOW);
    chat = applyDelta(chat, delta("m1", 3, "lo"), NOW);
    chat = applyDelta(chat, delta("m1", 4, "o, wo"), NOW);
    expect(chatItems(chat, []).map((i) => [i.text, i.state])).toEqual([["Hello, wo", "streaming"]]);
    expect(applyDelta(chat, delta("m1", 20, "x"), NOW).gap).toBe(true);
    chat = mergeMessages(chat, [msg(1, { text: "Hello, world", updatedAt: "2026-10-19T10:00:05.000Z" })]);
    expect(chatItems(chat, []).map((i) => [i.text, i.state])).toEqual([["Hello, world", "sent"]]);
    expect(applyDelta(chat, delta("m1", 12, "!"), NOW)).toBe(chat);
  });

  it("a chat joined mid-message goes on from history's text", () => {
    let chat = applyHistory(emptyChat, page([msg(1, { state: "streaming", text: "Halfway th" })]), "latest");
    chat = applyDelta(chat, delta("m1", 7, " through"), NOW);
    expect(chatItems(chat, [])[0]?.text).toBe("Halfway through");
  });

  it("a stream that starts before its message is listed shows as the lead's, last, at the time it began", () => {
    let chat = applyDelta(applyHistory(emptyChat, page([msg(1)]), "latest"), delta("m2", 0, "On it"), NOW);
    chat = applyDelta(chat, delta("m2", 5, "."), NOW + 30_000);
    expect(chatItems(chat, []).map((i) => [i.id, i.author, i.state, i.at])).toEqual([
      ["m1", "lead", "sent", "2026-10-19T10:00:01.000Z"],
      // Never "": the chat's day divider can't place an invalid date (Intl throws), which blanked the window.
      ["m2", "lead", "streaming", "2026-10-19T10:02:00.000Z"],
    ]);
  });

  it("kinds: inline items, migrated history and system lines; a newer hub's author is a system line", () => {
    const secret = msg(1, { text: "", item: { kind: "secret_request", requestId: "R1", name: "STRIPE_KEY", text: "Paste the key", sink: "env:STRIPE_KEY", state: "open" } });
    const migrated = msg(2, { author: "human", history: "order" });
    const robot = msg(3, { author: "robot" });
    const chat = applyHistory(emptyChat, page([secret, migrated, robot]), "latest");
    expect(chatItems(chat, []).map((i) => [i.kind, i.author])).toEqual([
      ["secret", "lead"],
      ["event", "human"],
      ["event", "system"],
    ]);
  });
});

describe("the person's sends", () => {
  it("a cut-off is never 'not sent'; a timeout is unanswered; a refusal fails; no hub queues it", () => {
    expect(afterCall(row("c1"), { ok: false, error: { code: "disconnected", message: "" } })?.state).toEqual({ t: "reconnecting" });
    expect(afterCall(row("c1"), { ok: false, error: { code: "timeout", message: "" } })?.state).toEqual({ t: "unanswered" });
    expect(afterCall(row("c1"), { ok: false, error: { code: "invalid", message: "too long" } })?.state.t).toBe("failed");
    expect(afterCall(row("c1"), { ok: false, error: { code: "offline", message: "" } })?.state).toEqual({ t: "queued" });
    expect(afterCall(row("c1", { reached: true }), { ok: false, error: { code: "offline", message: "" } })?.state).toEqual({ t: "reconnecting" });
    expect(afterCall(row("c1"), { ok: true, message: msg(5, { author: "human" }) })).toBeUndefined();
  });

  it("a resend keeps its place and remembers it may have reached the hub; only cut-off rows resend", () => {
    let rows = upsertSend([], row("c1"));
    rows = upsertSend(rows, row("c2"));
    rows = upsertSend(rows, { ...row("c1"), state: { t: "reconnecting" }, reached: true });
    rows = upsertSend(rows, row("c1"));
    expect(rows.map((r) => [r.clientRequestId, r.reached === true])).toEqual([
      ["c1", true],
      ["c2", false],
    ]);
    const failed = row("c3", { state: { t: "failed", error: { code: "invalid", message: "x" } } });
    expect(toResend([...rows, failed, row("c4", { state: { t: "unanswered" } })]).map((r) => r.clientRequestId)).toEqual(["c4"]);
  });

  it("the hub's echo settles its row, whichever comes first; a failed row never settles away", () => {
    const failed = row("c2", { state: { t: "failed", error: { code: "invalid", message: "x" } } });
    // The hub keeps a clientRequestId after the key that sent it.
    const echoes = [msg(9, { author: "human", clientRequestId: "key_7f3qa2m4:c1" }), msg(10, { author: "human", clientRequestId: "key_7f3qa2m4:c2" })];
    const rows = settleSends([row("c1"), failed], echoes);
    expect(rows.map((r) => r.clientRequestId)).toEqual(["c2"]);
    // The hub's copy is your send under the id it went with; the failed row it also has isn't a second one.
    const both = chatItems(mergeMessages(emptyChat, echoes), rows);
    expect(both.map((i) => [i.id, i.clientRequestId])).toEqual([
      ["m9", "c1"],
      ["m10", "c2"],
    ]);
    const items = chatItems(emptyChat, [row("c3", { state: { t: "reconnecting" } }), failed]);
    expect(items.map((i) => [i.id, i.author, i.state])).toEqual([
      ["c3", "human", "reconnecting"],
      ["c2", "human", "failed"],
    ]);
  });
});
