import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./desktop";
import { bubbles, sendNote } from "./chatView";

const message = (text: string, parts?: ChatMessage["parts"]): ChatMessage => ({
  messageId: "m1",
  projectRef: { machineId: "m", projectId: "p" },
  seq: 1,
  author: "lead",
  text,
  state: "final",
  createdAt: "2026-10-28T10:00:00Z",
  ...(parts === undefined ? {} : { parts }),
});

describe("bubbles", () => {
  it("is the text alone without parts", () => {
    expect(bubbles({ text: "Hi", message: message("Hi") })).toEqual([{ kind: "text", text: "Hi" }]);
  });

  it("splits parts and says blocks in words, keeping an ask's buttons", () => {
    const text = "First.\n\nSecond.[block][ask]";
    const parts: ChatMessage["parts"] = [
      { start: 0, end: 6 },
      { start: 8, end: 15 },
      { start: 15, end: 22, block: { v: 1, kind: "table", columns: [], rows: [] } as never },
      { start: 22, end: 27, block: { v: 1, kind: "ask", question: "Send it?" } },
    ];
    expect(bubbles({ text, message: message(text, parts) })).toEqual([
      { kind: "text", text: "First." },
      { kind: "text", text: "Second." },
      { kind: "block", text: "A table the desktop app shows." },
      { kind: "ask", question: "Send it?", options: ["Approve", "Deny"] },
    ]);
  });
});

describe("sendNote", () => {
  it("says where a send is, and nothing once sent", () => {
    expect(sendNote({ state: "queued" })).toBe("Not connected: it goes when the hub is back.");
    expect(sendNote({ state: "failed", error: { code: "invalid", message: "Too long." } })).toBe("Not sent: Too long. Tap to send again.");
    expect(sendNote({ state: "sent" })).toBeUndefined();
  });
});
