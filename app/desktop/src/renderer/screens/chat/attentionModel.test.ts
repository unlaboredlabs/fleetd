// What the line above the composer says the lead waits on you for, and where Show goes.
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/data/chat";
import type { ChatMessage } from "../../../shared/contracts";
import { countQuestions, waitingOn } from "./attentionModel";

const at = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 9, d, h, m)).toISOString();
const NOW = Date.parse(at(19, 18));
const item = (id: string, author: ChatItem["author"], text: string, time = at(19, 9, 2), over: Partial<ChatItem> = {}): ChatItem => ({
  id,
  author,
  kind: "message",
  text,
  at: time,
  attachments: [],
  state: "sent",
  ...over,
});
const inline = (id: string, kind: "secret" | "gated", state: string): ChatItem =>
  item(id, "lead", "", at(19, 9, 5), {
    kind,
    message: { item: kind === "secret" ? { kind: "secret_request", state } : { kind: "command_approval", state } } as unknown as ChatMessage,
  });
const QUESTIONS = "Two calls before I ship it:\n\n1. **Copy link**: public or image only? Rec: public.\n2. **Headline**: literal or prorated? Rec: literal.";

describe("what the lead waits on", () => {
  it("counts the lead's numbered questions, and says when it asked", () => {
    expect(waitingOn([item("a", "human", "ship it"), item("b", "lead", QUESTIONS)], false, NOW, "UTC")).toEqual({ what: "2 questions, asked at 09:02", targets: [{ id: "b", part: "0" }] });
    expect(waitingOn([item("b", "lead", "Looks good on your end?", at(18, 16, 40))], false, NOW, "UTC")).toEqual({ what: "1 question, asked yesterday at 16:40", targets: [{ id: "b", part: "0" }] });
    expect(waitingOn([item("b", "lead", "Is it live?", at(12, 8))], false, NOW, "UTC")?.what).toBe("1 question, asked Mon 12 Oct at 08:00");
  });

  it("says nothing after a plain status line, with nothing open", () => {
    expect(waitingOn([item("a", "human", "ship it"), item("b", "lead", "Done. Over to you.")], false, NOW, "UTC")).toBeUndefined();
    expect(waitingOn([item("b", "lead", "Done. Over to you.")], false, NOW, "UTC")).toBeUndefined();
    // Your reply answers the question before it.
    expect(waitingOn([item("a", "lead", QUESTIONS), item("h", "human", "public, literal"), item("b", "lead", "Shipped.")], false, NOW, "UTC")).toBeUndefined();
  });

  it("goes to an earlier question you haven't answered, past the lead's later status lines", () => {
    const items = [item("h", "human", "go"), item("a", "lead", QUESTIONS, at(19, 8, 30)), item("b", "lead", "Merged #12.", at(19, 9, 47)), item("c", "lead", "Done. Over to you.", at(19, 9, 50))];
    expect(waitingOn(items, false, NOW, "UTC")).toEqual({ what: "2 questions, asked at 08:30", targets: [{ id: "a", part: "0" }] });
  });

  it("goes to each bubble that asks, an ask block among them", () => {
    const split = (text: string, parts: ChatMessage["parts"]) => item("b", "lead", text, at(19, 9, 2), { message: { parts } as ChatMessage });
    const text = "Built it.Merge #12 now?Tag v2.4?";
    const ask = { v: 1, kind: "ask", question: "Tag v2.4" } as const;
    expect(waitingOn([split(text, [{ start: 0, end: 9 }, { start: 9, end: 23 }, { start: 23, end: 32, block: ask }])], false, NOW, "UTC")).toEqual({
      what: "2 questions, asked at 09:02",
      targets: [
        { id: "b", part: "1" },
        { id: "b", part: "2" },
      ],
    });
    expect(waitingOn([split("Built it.Shipped.", [{ start: 0, end: 9 }, { start: 9, end: 17 }])], false, NOW, "UTC")).toBeUndefined();
  });

  it("puts an open approval or secret first, and goes to each in turn from the oldest", () => {
    const items = [item("b", "lead", QUESTIONS), inline("g1", "gated", "open"), inline("s1", "secret", "open"), inline("g2", "gated", "open"), inline("g0", "gated", "ran")];
    expect(waitingOn(items, false, NOW, "UTC")).toEqual({ what: "2 commands to approve, 1 secret to enter", targets: [{ id: "g1" }, { id: "s1" }, { id: "g2" }] });
    expect(waitingOn([inline("s1", "secret", "stored"), inline("g1", "gated", "open")], false, NOW, "UTC")).toEqual({ what: "1 command to approve", targets: [{ id: "g1" }] });
  });

  it("still says it waits when the ask isn't loaded, with nowhere to show", () => {
    expect(waitingOn([item("a", "human", "hi")], false, NOW, "UTC")).toBeUndefined();
    expect(waitingOn([item("b", "lead", "Done. Over to you.")], true, NOW, "UTC")).toEqual({ what: "a reply", targets: [] });
    // Older pages come before your message, so you've answered them.
    expect(waitingOn([item("a", "human", "ship it"), item("b", "lead", "Done. Over to you.")], true, NOW, "UTC")).toBeUndefined();
  });

  it("reads numbered lines as questions, not numbers inside a sentence", () => {
    expect(countQuestions("1. one\n2) two\n   3. three\nnot 4. this")).toBe(3);
    expect(countQuestions("We shipped 2. Next?")).toBe(1);
    expect(countQuestions("All merged.")).toBe(0);
  });
});
