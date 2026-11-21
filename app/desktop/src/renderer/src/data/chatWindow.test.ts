import { describe, expect, it } from "vitest";
import { applyHistory, emptyChat, holds, joinWindow, openWindow, pageWindow, windowJoins } from "./chat";
import type { ChatHistoryOutput, ChatMessage } from "./chat-contract";

const ref = { machineId: "devbox", projectId: "storefront" };
const msg = (seq: number): ChatMessage => ({ messageId: `m${seq}`, projectRef: ref, seq, author: "lead", state: "final", text: `message ${seq}`, createdAt: new Date(seq * 60_000).toISOString() });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));
const page = (messages: ChatMessage[], moreBefore: boolean, moreAfter: boolean) => ({ messages, moreBefore, moreAfter });
const latest = (messages: ChatMessage[], moreBefore: boolean): ChatHistoryOutput =>
  ({ messages, moreBefore, moreAfter: false, state: { projectRef: ref, needsYou: false, leadWorking: false, lastSeq: messages.at(-1)?.seq ?? 0 } });

describe("a window far back in a chat", () => {
  // The chat holds its newest 50 of 10,000; a search hit is message 120.
  const chat = applyHistory(emptyChat, latest(range(9951, 10_000), true), "latest");

  it("opens around its message without the chat between it and the loaded part", () => {
    expect(holds(chat, "m120")).toBe(false);
    const w = openWindow("m120", page(range(96, 145), true, true));
    expect([w.messages[0]?.seq, w.messages.at(-1)?.seq, w.hasOlder, w.hasNewer]).toEqual([96, 145, true, true]);
    expect(windowJoins(w, chat)).toBe(false);
  });

  it("pages both ways, and joins the chat once its newest message reaches the chat's oldest", () => {
    let w = openWindow("m9880", page(range(9856, 9905), true, true));
    w = pageWindow(w, page(range(9806, 9855), true, false), true);
    expect([w.messages[0]?.seq, w.hasOlder]).toEqual([9806, true]);
    expect(windowJoins(w, chat)).toBe(false);
    w = pageWindow(w, page(range(9906, 9950), true, true), false);
    expect(windowJoins(w, chat)).toBe(true);
    const joined = joinWindow(chat, w);
    expect([joined.messages[0]?.seq, joined.messages.at(-1)?.seq, joined.messages.length, joined.hasOlder]).toEqual([9806, 10_000, 195, true]);
  });

  it("a window that reaches the newest message joins at once", () => {
    const w = openWindow("m9990", page(range(9966, 10_000), true, false));
    expect(windowJoins(w, chat)).toBe(true);
  });
});
