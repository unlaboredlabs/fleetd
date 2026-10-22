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
    expect(waitingOn([item("a", "human", "ship it"), item("b", "lead", QUESTIONS)], NOW, "UTC")).toEqual({ what: "2 questions, asked at 09:02", target: "b" });
    expect(waitingOn([item("b", "lead", "Looks good on your end?", at(18, 16, 40))], NOW, "UTC")).toEqual({ what: "1 question, asked yesterday at 16:40", target: "b" });
    expect(waitingOn([item("b", "lead", "Done. Over to you.", at(12, 8))], NOW, "UTC").what).toBe("a reply to its message Mon 12 Oct at 08:00");
  });

  it("puts an open approval or secret first, and goes to the oldest", () => {
    const items = [item("b", "lead", QUESTIONS), inline("g1", "gated", "open"), inline("s1", "secret", "open"), inline("g2", "gated", "open"), inline("g0", "gated", "ran")];
    expect(waitingOn(items, NOW, "UTC")).toEqual({ what: "2 commands to approve, 1 secret to enter", target: "g1" });
    expect(waitingOn([inline("s1", "secret", "stored"), inline("g1", "gated", "open")], NOW, "UTC")).toEqual({ what: "1 command to approve", target: "g1" });
  });

  it("still says it waits when the ask isn't loaded, with nowhere to show", () => {
    expect(waitingOn([item("a", "human", "hi")], NOW, "UTC")).toEqual({ what: "a reply" });
  });

  it("reads numbered lines as questions, not numbers inside a sentence", () => {
    expect(countQuestions("1. one\n2) two\n   3. three\nnot 4. this")).toBe(3);
    expect(countQuestions("We shipped 2. Next?")).toBe(1);
    expect(countQuestions("All merged.")).toBe(0);
  });
});
