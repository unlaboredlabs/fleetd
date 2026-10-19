import { describe, expect, it } from "vitest";
import { afterCall, applyDelta, applyHistory, CHAT_KEEP, chatItems, emptyChat, mergeMessages, settleSends, toResend, upsertSend, type ChatSend } from "./chat";
import type { ChatMessage } from "./chat-contract";

const ref = { machineId: "devbox", projectId: "storefront" };
const msg = (seq: number, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: `m${seq}`,
  projectRef: ref,
  seq,
  author: "lead",
  kind: "message",
  text: `message ${seq}`,
  createdAt: `2026-10-19T10:00:${String(seq % 60).padStart(2, "0")}.000Z`,
  ...patch,
});
const row = (id: string, patch: Partial<ChatSend> = {}): ChatSend => ({
  clientRequestId: id,
  text: "ship it",
  attachments: [],
  at: "2026-10-19T10:01:00.000Z",
  state: { t: "sending" },
  ...patch,
});

describe("chat messages", () => {
  it("merge by id in seq order, from any source in any order, and an older copy never wins", () => {
    let chat = applyHistory(emptyChat, { messages: [msg(2), msg(3)], hasOlder: true, needsYou: false }, false);
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
    let chat = applyHistory(emptyChat, { messages: [msg(100)], hasOlder: true, needsYou: false }, false);
    chat = applyHistory({ ...chat, loadingOlder: true }, { messages: [msg(99)], hasOlder: false, needsYou: false }, true);
    expect([chat.hasOlder, chat.loadingOlder, chat.messages.length]).toEqual([false, false, 2]);
    const many = Array.from({ length: CHAT_KEEP + 5 }, (_, i) => msg(1000 + i));
    chat = mergeMessages(chat, many);
    expect(chat.messages).toHaveLength(CHAT_KEEP);
    expect(chat.messages[0]?.seq).toBe(1005);
    expect(chat.hasOlder).toBe(true);
  });

  it("streams text idempotently, ends the stream on the finished message, and flags a gap", () => {
    let chat = applyHistory(emptyChat, { messages: [msg(1, { streaming: true, text: "Hel" })], hasOlder: false, needsYou: false }, false);
    chat = applyDelta(chat, { projectRef: ref, messageId: "m1", offset: 3, append: "lo" });
    chat = applyDelta(chat, { projectRef: ref, messageId: "m1", offset: 3, append: "lo" });
    chat = applyDelta(chat, { projectRef: ref, messageId: "m1", offset: 4, append: "o, wo" });
    expect(chatItems(chat, []).map((i) => [i.text, i.state])).toEqual([["Hello, wo", "streaming"]]);
    expect(applyDelta(chat, { projectRef: ref, messageId: "m1", offset: 20, append: "x" }).gap).toBe(true);
    chat = mergeMessages(chat, [msg(1, { text: "Hello, world", updatedAt: "2026-10-19T10:00:05.000Z" })]);
    expect(chatItems(chat, []).map((i) => [i.text, i.state])).toEqual([["Hello, world", "sent"]]);
    expect(applyDelta(chat, { projectRef: ref, messageId: "m1", offset: 12, append: "!" })).toBe(chat);
  });

  it("a stream that starts before its message is listed shows as the lead's, last", () => {
    const chat = applyDelta(applyHistory(emptyChat, { messages: [msg(1)], hasOlder: false, needsYou: false }, false), {
      projectRef: ref,
      messageId: "m2",
      offset: 0,
      append: "On it",
    });
    expect(chatItems(chat, []).map((i) => [i.id, i.author, i.state])).toEqual([
      ["m1", "lead", "sent"],
      ["m2", "lead", "streaming"],
    ]);
  });
});

describe("the person's sends", () => {
  it("a cut-off is never 'not sent'; a timeout is unanswered; a refusal fails; offline fails only if never reached", () => {
    expect(afterCall(row("c1"), { ok: false, error: { code: "disconnected", message: "" } })?.state).toEqual({ t: "reconnecting" });
    expect(afterCall(row("c1"), { ok: false, error: { code: "timeout", message: "" } })?.state).toEqual({ t: "unanswered" });
    expect(afterCall(row("c1"), { ok: false, error: { code: "invalid", message: "too long" } })?.state.t).toBe("failed");
    expect(afterCall(row("c1"), { ok: false, error: { code: "offline", message: "" } })?.state).toMatchObject({ t: "failed", offline: true });
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
    const rows = settleSends([row("c1"), failed], [msg(9, { author: "human", clientRequestId: "c1" }), msg(10, { author: "human", clientRequestId: "c2" })]);
    expect(rows.map((r) => r.clientRequestId)).toEqual(["c2"]);
    const items = chatItems(emptyChat, [row("c3", { state: { t: "reconnecting" } }), failed]);
    expect(items.map((i) => [i.id, i.author, i.state])).toEqual([
      ["c3", "human", "reconnecting"],
      ["c2", "human", "failed"],
    ]);
  });
});
