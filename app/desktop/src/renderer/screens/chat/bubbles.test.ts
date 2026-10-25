import { describe, expect, it } from "vitest";
import type { ChatBlock, ChatMessage } from "../../../shared/contracts";
import type { ChatItem } from "../../src/data/chat";
import { askAnswer, bubblesOf, quoted, quoteOf, replyOf, replyText, tapbackSend, type Bubble } from "./bubbles";

const AT = "2026-10-19T09:00:00.000Z";
const item = (id: string, author: ChatItem["author"], text: string, over: Partial<ChatItem> = {}): ChatItem => ({
  id,
  author,
  kind: "message",
  text,
  at: AT,
  attachments: [],
  state: "sent",
  ...over,
});
const split = (text: string, parts: ChatMessage["parts"]): ChatItem => item("m", "lead", text, { message: { parts } as ChatMessage });
const chart: ChatBlock = { v: 1, kind: "chart", chart: "line", title: "Build time", x: ["Mon", "Tue"], series: [{ name: "main", values: [4, 3] }] };

describe("a message's bubbles", () => {
  it("are one per part the hub split it into, a block where the part has one this build reads", () => {
    const text = "Done.\n\nHere's the week:\n```fleetd-block\n{}\n```";
    const fence = text.indexOf("```");
    const bubbles = bubblesOf(split(text, [{ start: 0, end: 5 }, { start: 7, end: fence }, { start: fence, end: text.length, block: chart }]));
    expect(bubbles.map((b) => (b.kind === "block" ? `block:${b.block.kind}` : b.text))).toEqual(["Done.", "Here's the week:", "block:chart"]);
  });

  it("show a block from a newer schema, or one missing what it draws from, as its text", () => {
    const newer = { ...chart, v: 2 } as ChatBlock;
    const broken = { ...chart, series: [{ name: "main", values: [1] }] } as ChatBlock;
    const unknown = { v: 1, kind: "poll" } as unknown as ChatBlock;
    for (const block of [newer, broken, unknown]) {
      expect(bubblesOf(split("```fleetd-block\n{}\n```", [{ start: 0, end: 22, block }]))).toEqual([{ kind: "text", key: "0", text: "```fleetd-block\n{}\n```" }]);
    }
  });

  it("are one bubble of text without parts, and none while the lead is still writing", () => {
    expect(bubblesOf(item("a", "human", "ship it"))).toEqual([{ kind: "text", key: "0", text: "ship it" }]);
    expect(bubblesOf(item("a", "lead", "Half a sen", { state: "streaming" }))).toEqual([]);
    expect(bubblesOf(item("a", "human", "  "))).toEqual([]);
  });
});

describe("a reply", () => {
  it("quotes the bubble's first line as plain words, cut to a line", () => {
    expect(quoteOf("## The plan\n\n1. **Dates** first")).toBe("The plan");
    expect(quoteOf("```ts\ncode\n```\nThen `roundTotal` runs")).toBe("Then roundTotal runs");
    expect(quoteOf("x".repeat(200))).toHaveLength(90);
  });

  it("travels as a quote line, a blank line and your words, and reads back the same", () => {
    const text = replyText("Merge the dates PR first?", "yes, then discounts");
    expect(text).toBe("> Merge the dates PR first?\n\nyes, then discounts");
    expect(replyOf(text)).toEqual({ quote: "Merge the dates PR first?", body: "yes, then discounts" });
    // A message that merely starts with a quote block is not a reply.
    expect(replyOf("> one\n> two\n\nok")).toBeUndefined();
    expect(replyOf("> one")).toBeUndefined();
  });

  it("finds the lead's bubble it quotes, the newest before it", () => {
    const items = [item("a", "lead", "Merge the dates PR first?"), item("b", "lead", "Merge the dates PR first? Still asking."), item("c", "human", "")];
    expect(quoted(items, 2, "Merge the dates PR first?")).toBe("b");
    expect(quoted(items, 1, "Merge the dates PR first?")).toBe("a");
    expect(quoted(items, 2, "Something else")).toBeUndefined();
  });
});

describe("a tapback", () => {
  const text: Bubble = { kind: "text", key: "0", text: "Ready to merge both?" };
  const approve: Bubble = { kind: "block", key: "1", text: "", block: { v: 1, kind: "ask", question: "Merge both?" } };
  const pick: Bubble = { kind: "block", key: "1", text: "", block: { v: 1, kind: "ask", question: "Which first?", options: ["Dates", "Discounts"] } };

  it("sends nothing but a 👍 on what waits for you", () => {
    expect(tapbackSend("❤️", text, true, true)).toBeUndefined();
    expect(tapbackSend("👍", text, false, true)).toBeUndefined();
    expect(tapbackSend("👍", text, true, true)).toEqual({ t: "reply", text: "> Ready to merge both?\n\n👍" });
  });

  it("approves an open approve-or-deny ask, and never picks an option for you", () => {
    expect(tapbackSend("👍", approve, false, true)).toEqual({ t: "answer", text: "Approve" });
    expect(tapbackSend("👍", approve, false, false)).toBeUndefined();
    expect(tapbackSend("👍", pick, true, true)).toBeUndefined();
  });
});

it("an ask's answer is your first later message that is one of its buttons, in a reply or not", () => {
  const items = [item("a", "lead", ""), item("b", "human", "hmm, why?"), item("c", "human", replyText("Which first?", "discounts")), item("d", "human", "Dates")];
  expect(askAnswer(items, 0, ["Dates", "Discounts"])).toBe("Discounts");
  expect(askAnswer(items, 0, undefined)).toBeUndefined();
  expect(askAnswer([...items, item("e", "human", "approve")], 0, undefined)).toBe("Approve");
  expect(askAnswer([item("a", "lead", ""), item("b", "human", "Deny", { state: "failed" })], 0, undefined)).toBeUndefined();
});
