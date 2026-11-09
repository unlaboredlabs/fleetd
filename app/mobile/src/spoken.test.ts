import { describe, expect, it } from "vitest";
import { arrivalsOf, type Arrival } from "./arrivals";
import type { ChatItem } from "./desktop";
import { arrivedReplies, bubbleActions, bubbleLabel, spokenText } from "./spoken";

const item = (id: string, seq: number, text: string, extra: Partial<ChatItem> = {}): ChatItem => ({
  id,
  author: "lead",
  kind: "message",
  text,
  at: "2026-10-28T10:00:00Z",
  attachments: [],
  state: "sent",
  message: { messageId: id, projectRef: { machineId: "m", projectId: "p" }, seq, author: "lead", text, state: "final", createdAt: "2026-10-28T10:00:00Z" },
  ...extra,
});

describe("a bubble as VoiceOver says it", () => {
  it("reads who wrote it, the words without their markup, and when", () => {
    expect(bubbleLabel("Ada", spokenText("Two **emails** need you: see `inbox`."), "9:41")).toBe("Ada, Two emails need you: see inbox., 9:41");
  });

  it("reads a table row by row, each value after its column's name", () => {
    expect(spokenText("| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 41 |")).toBe("Name Alice, Age 30\nName Bob, Age 41");
  });

  it("reads lists and quotes line by line", () => {
    expect(spokenText("Done:\n\n- one\n- two\n\n> quoted")).toBe("Done:\none\ntwo\nquoted");
  });
});

describe("what VoiceOver can do inside a bubble", () => {
  it("opens each link once, named by its site, and copies each code block", () => {
    const text = "See [the PR](https://github.com/acme/shop/pull/7) and https://www.example.com/a, again [here](https://github.com/acme/shop/pull/7).\n\n```sh\nnpm test\n```";
    expect(bubbleActions(text)).toEqual([
      { t: "open", label: "Open github.com", url: "https://github.com/acme/shop/pull/7" },
      { t: "open", label: "Open example.com", url: "https://www.example.com/a" },
      { t: "copy", label: "Copy Code", text: "npm test" },
    ]);
  });

  it("tells two links to one site apart by their path, and numbers code blocks", () => {
    const text = "https://github.com/a and https://github.com/b\n\n```\none\n```\n\n```\ntwo\n```";
    expect(bubbleActions(text).map((a) => a.label)).toEqual(["Open github.com/a", "Open github.com/b", "Copy Code 1", "Copy Code 2"]);
  });

  it("has nothing to add for plain words", () => {
    expect(bubbleActions("Morning.")).toEqual([]);
  });
});

describe("a reply that comes in while VoiceOver is on", () => {
  it("is said once its words are written, by who wrote it, its first line", () => {
    const opened = arrivalsOf(undefined, [item("a", 1, "Morning.")], true, 0);
    const heard = new Set<Arrival>();
    const streaming = arrivalsOf(opened, [item("a", 1, "Morning."), item("b", 2, "Two **emails**", { state: "streaming" })], true, 10);
    expect(arrivedReplies(heard, streaming.entering, [item("b", 2, "", { state: "streaming" })], "Ada")).toEqual([]);
    const done = [item("a", 1, "Morning."), item("b", 2, "Two **emails** need you.\n\nThe first is from Bo.")];
    const written = arrivalsOf(streaming, done, true, 20);
    expect(arrivedReplies(heard, written.entering, done, "Ada")).toEqual(["Ada: Two emails need you."]);
    // Said once: the next word elsewhere doesn't say it again.
    expect(arrivedReplies(heard, arrivalsOf(written, done, true, 30).entering, done, "Ada")).toEqual([]);
  });

  it("isn't what the chat opened with, nor your own send", () => {
    const opened = arrivalsOf(undefined, [item("a", 1, "Morning.")], true, 0);
    expect(opened.entering.size).toBe(0);
    const mine = [item("a", 1, "Morning."), item("b", 2, "Thanks", { author: "human" })];
    expect(arrivedReplies(new Set(), arrivalsOf(opened, mine, true, 10).entering, mine, "Ada")).toEqual([]);
  });
});
