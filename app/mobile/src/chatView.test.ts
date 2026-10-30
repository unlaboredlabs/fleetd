import { describe, expect, it } from "vitest";
import { applyDelta, applyHistory, chatItems, emptyChat, type Chat, type ChatItem, type ChatMessage } from "./desktop";
import { attachmentBubbles, bubbleTime, bubbles, dayLine, fileSize, fullTime, listTime, previewOf, quoteOf, replyOf, replyText, sameRow, sendNote, threadRows, timeLine, type ThreadRow } from "./chatView";

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

  it("splits parts into bubbles and cards, saying the desktop's blocks in words", () => {
    const text = "First.\n\nSecond.[block][ask][pr][list][chart]";
    const parts: ChatMessage["parts"] = [
      { start: 0, end: 6 },
      { start: 8, end: 15 },
      { start: 15, end: 22, block: { v: 1, kind: "table", title: "Runs", columns: ["a"], rows: [["1"]] } },
      { start: 22, end: 27, block: { v: 1, kind: "ask", question: "Send it?" } },
      { start: 27, end: 31, block: { v: 1, kind: "pr", repo: "acme/api", number: 7 } },
      { start: 31, end: 37, block: { v: 1, kind: "checklist", items: [{ done: true, text: "Tests" }] } },
      { start: 37, end: 44, block: { v: 1, kind: "chart", type: "line", x: [], series: [] } as never },
    ];
    expect(bubbles({ text, message: message(text, parts) })).toEqual([
      { kind: "text", text: "First." },
      { kind: "text", text: "Second." },
      { kind: "table", title: "Runs", columns: ["a"], rows: [["1"]] },
      { kind: "ask", question: "Send it?", options: ["Approve", "Deny"] },
      { kind: "pr", repo: "acme/api", number: 7, title: undefined },
      { kind: "checklist", title: undefined, items: [{ done: true, text: "Tests" }] },
      { kind: "block", text: "A chart the desktop app shows." },
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

const item = (id: string, author: ChatItem["author"], at: string, extra: Partial<ChatItem> = {}): ChatItem => ({
  id,
  author,
  kind: "message",
  text: id,
  at,
  attachments: [],
  state: "sent",
  ...extra,
});

describe("threadRows", () => {
  it("groups a side's burst, tails its last, and puts a day line where a day starts", () => {
    const rows = threadRows([
      item("a", "human", "2026-10-28T10:00:00Z"),
      item("b", "human", "2026-10-28T10:01:00Z"),
      item("c", "lead", "2026-10-28T10:02:00Z"),
      item("d", "lead", "2026-10-28T10:20:00Z"),
      item("e", "lead", "2026-10-28T11:00:00Z"),
      item("f", "lead", "2026-10-29T08:00:00Z"),
    ], false, undefined, { timeZone: "UTC" });
    expect(rows.map((r) => (r.t === "item" ? `${r.id}:${r.side}:${r.first ? "F" : "-"}${r.last ? "L" : "-"}` : r.t))).toEqual([
      "day",
      "a:me:F-",
      "b:me:-L",
      "c:them:FL",
      "d:them:FL",
      "e:them:FL",
      "day",
      "f:them:FL",
    ]);
  });

  it("doesn't group two agents, and centres events", () => {
    const rows = threadRows([
      item("a", "agent", "2026-10-28T10:00:00Z", { message: { ...message("a"), author: "agent", by: "T1" } }),
      item("b", "agent", "2026-10-28T10:00:10Z", { message: { ...message("b"), author: "agent", by: "T2" } }),
      item("c", "system", "2026-10-28T10:00:20Z", { kind: "event" }),
    ]);
    expect(rows.flatMap((r) => (r.t === "item" ? [`${r.side}:${String(r.first && r.last)}`] : []))).toEqual(["them:true", "them:true", "center:true"]);
  });

  it("ends with the turn line while the lead works, under its reply as it streams too, as the desktop's", () => {
    const sent = [item("a", "human", "2026-10-28T10:00:00Z")];
    expect(threadRows(sent, true).at(-1)).toEqual({ t: "turn", id: "turn" });
    expect(threadRows(sent, false).at(-1)?.t).toBe("item");
    const streaming = threadRows([...sent, item("b", "lead", "2026-10-28T10:00:01Z", { state: "streaming" })], true);
    expect(streaming.slice(-2).map((r) => r.t)).toEqual(["item", "turn"]);
  });
});

describe("times", () => {
  const clock = { nowMs: Date.parse("2026-10-29T15:00:00Z"), locale: "en-GB", timeZone: "UTC" };
  it("words a time line as iMessage does", () => {
    expect(timeLine("2026-10-29T09:41:00Z", clock)).toBe("Today 9:41");
    expect(timeLine("2026-10-28T18:02:00Z", clock)).toBe("Yesterday 18:02");
    expect(timeLine("2026-10-27T09:12:00Z", clock)).toBe("Tuesday 9:12");
    expect(timeLine("2026-10-12T09:12:00Z", clock)).toBe("12 Oct 2026 at 9:12");
  });

  it("words a day line, a bubble's time and its full time", () => {
    expect(dayLine("2026-10-29T09:41:00Z", clock)).toBe("Today");
    expect(dayLine("2026-10-28T18:02:00Z", clock)).toBe("Yesterday");
    expect(dayLine("2026-10-12T09:12:00Z", clock)).toBe("Monday 12 October");
    expect(dayLine("2025-10-12T09:12:00Z", clock)).toBe("Sunday, 12 October 2025");
    expect(bubbleTime("2026-10-29T09:41:00Z", clock)).toBe("9:41");
    expect(fullTime("2026-10-29T09:41:00Z", clock)).toBe("Thursday, 29 October 2026 at 9:41");
  });

  it("words a list row's time shorter", () => {
    expect(listTime("2026-10-29T09:41:00Z", clock)).toBe("9:41");
    expect(listTime("2026-10-28T09:41:00Z", clock)).toBe("Yesterday");
    expect(listTime("2026-10-26T09:41:00Z", clock)).toBe("Monday");
    expect(listTime("2026-10-12T09:41:00Z", clock)).toBe("12/10/26");
  });

  it("counts days in the phone's zone", () => {
    expect(listTime("2026-10-29T01:00:00Z", { ...clock, timeZone: "America/Los_Angeles" })).toBe("Yesterday");
  });
});

describe("previewOf", () => {
  it("is the message's text in one line, the person's after You", () => {
    expect(previewOf({ author: "lead", text: "**Done**: see `x`", message: message("**Done**: see `x`") })).toBe("Done: see x");
    expect(previewOf({ author: "human", text: "On my way", message: undefined })).toBe("You: On my way");
    expect(previewOf({ author: "lead", text: "", message: { ...message(""), item: { kind: "command_approval", requestId: "r" } as never } })).toBe("Asks for your approval");
  });
});

describe("replies", () => {
  it("quotes a bubble's first line as plain words, cut to a line", () => {
    expect(quoteOf("## **Done**: see [the PR](https://x)\n\nMore")).toBe("Done: see the PR");
    expect(quoteOf(`${"a".repeat(120)}`)).toHaveLength(90);
    expect(quoteOf("```\ncode\n```\nAfter")).toBe("After");
  });

  it("writes a reply as the desktop app does, and reads it back", () => {
    const text = replyText("Ship it today?", "Yes, after lunch.");
    expect(text).toBe("> Ship it today?\n\nYes, after lunch.");
    expect(replyOf(text)).toEqual({ quote: "Ship it today?", body: "Yes, after lunch." });
    expect(replyOf("> just a quote")).toBeUndefined();
    expect(replyText("", "Plain")).toBe("Plain");
  });

  it("previews a reply by its words, not its quote", () => {
    expect(previewOf({ author: "human", text: replyText("Ship it?", "Yes"), message: undefined })).toBe("You: Yes");
  });
});

describe("attachments", () => {
  it("shows pictures as themselves and other files as files", () => {
    const attachments = [
      { attachmentId: "a", name: "shot.png", mime: "image/png" as const, bytes: 10 },
      { attachmentId: "b", name: "notes.pdf", mime: "application/pdf" as const, bytes: 2048 },
    ];
    expect(attachmentBubbles({ attachments })).toEqual([
      { kind: "image", attachmentId: "a", name: "shot.png" },
      { kind: "file", attachmentId: "b", name: "notes.pdf", mime: "application/pdf", bytes: 2048 },
    ]);
    expect(previewOf({ author: "lead", text: "", message: undefined, attachments })).toBe("Photo notes.pdf");
    expect(fileSize(2048)).toBe("2 KB");
  });

  it("draws an image block as a picture", () => {
    const parts: ChatMessage["parts"] = [{ start: 0, end: 0, block: { v: 1, kind: "image", attachmentId: "a", caption: "The chart" } as never }];
    expect(bubbles({ text: "", message: message("", parts) })).toEqual([{ kind: "image", attachmentId: "a", name: "The chart", caption: "The chart" }]);
  });
});

describe("the unread bar", () => {
  const item = (id: string, seq: number, author: ChatItem["author"]): ChatItem => ({
    id,
    author,
    kind: "message",
    text: id,
    at: "2026-10-28T10:00:00Z",
    attachments: [],
    state: "sent",
    message: { ...message(id), messageId: id, seq, author },
  });

  it("goes before the first message from the other side after what was read, and starts a burst there", () => {
    const rows = threadRows([item("a", 1, "lead"), item("b", 2, "human"), item("c", 3, "lead"), item("d", 4, "lead")], false, 1);
    expect(rows.map((r) => (r.t === "item" ? r.id : r.t))).toEqual(["day", "a", "b", "unread", "c", "d"]);
    const c = rows.find((r) => r.t === "item" && r.id === "c");
    expect(c?.t === "item" && c.first).toBe(true);
  });

  it("isn't there when everything was read, or nothing was known", () => {
    expect(threadRows([item("a", 1, "lead")], false, 1).some((r) => r.t === "unread")).toBe(false);
    expect(threadRows([item("a", 1, "lead")]).some((r) => r.t === "unread")).toBe(false);
  });
});

describe("sameRow", () => {
  const ref = { machineId: "m", projectId: "p" };
  const msg = (seq: number, author: string, text: string, state = "final"): ChatMessage => ({
    messageId: `m${String(seq)}`,
    projectRef: ref,
    seq,
    author,
    text,
    state,
    createdAt: `2026-10-28T10:0${String(seq)}:00Z`,
  });
  const page = (messages: ChatMessage[]) => ({ messages, moreAfter: false, moreBefore: false, state: { projectRef: ref, lastSeq: messages.length, leadWorking: true, needsYou: false } });
  const rowsOf = (chat: Chat) => threadRows(chatItems(chat, []), true);

  it("redraws only the streaming bubble when a word comes", () => {
    const chat = applyHistory(emptyChat, page([msg(1, "human", "Hi"), msg(2, "lead", "Hello."), msg(3, "human", "Status?"), msg(4, "lead", "Wor", "streaming")]), "latest");
    const before = rowsOf(chat);
    const after = rowsOf(applyDelta(chat, { projectRef: ref, messageId: "m4", offset: 3, append: "king on it", seq: 4 }, Date.now()));
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    // The turn line under it, last, draws nothing again either.
    expect(after.map((r, i) => sameRow(r, before[i] as ThreadRow))).toEqual([true, true, true, true, false, true]);
  });

  it("redraws the bubble above a new one in its burst, which loses its tail", () => {
    const chat = applyHistory(emptyChat, page([msg(1, "lead", "One.")]), "latest");
    const next = applyHistory(chat, page([msg(1, "lead", "One."), msg(2, "lead", "Two.")]), "latest");
    const [day, one] = rowsOf(chat);
    const [day2, one2] = rowsOf(next);
    expect(sameRow(day as ThreadRow, day2 as ThreadRow)).toBe(true);
    expect(sameRow(one as ThreadRow, one2 as ThreadRow)).toBe(false);
  });
});
