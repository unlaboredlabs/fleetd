import { describe, expect, it } from "vitest";
import type { ChatItem, ChatMessage } from "./desktop";
import { bubbles, listTime, previewOf, sendNote, threadRows, timeLine } from "./chatView";

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
  it("groups a side's burst, tails its last, and puts a time line after a quiet", () => {
    const rows = threadRows([
      item("a", "human", "2026-10-28T10:00:00Z"),
      item("b", "human", "2026-10-28T10:01:00Z"),
      item("c", "lead", "2026-10-28T10:02:00Z"),
      item("d", "lead", "2026-10-28T10:20:00Z"),
      item("e", "lead", "2026-10-28T11:00:00Z"),
    ]);
    expect(rows.map((r) => (r.t === "item" ? `${r.id}:${r.side}:${r.first ? "F" : "-"}${r.last ? "L" : "-"}` : r.t))).toEqual([
      "time",
      "a:me:F-",
      "b:me:-L",
      "c:them:FL",
      "d:them:FL",
      "time",
      "e:them:FL",
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

  it("ends with a typing bubble while the lead works, unless its text streams", () => {
    const sent = [item("a", "human", "2026-10-28T10:00:00Z")];
    expect(threadRows(sent, true).at(-1)).toEqual({ t: "typing", id: "typing" });
    expect(threadRows(sent, false).at(-1)?.t).toBe("item");
    expect(threadRows([...sent, item("b", "lead", "2026-10-28T10:00:01Z", { state: "streaming" })], true).at(-1)?.t).toBe("item");
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
