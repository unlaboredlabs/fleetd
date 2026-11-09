import { describe, expect, it } from "vitest";
import { applyDelta, applyHistory, chatItems, emptyChat, type Chat, type ChatItem, type ChatMessage } from "./desktop";
import { aimOf, attachmentBubbles, bubbleTime, bubbles, dayLine, fileSize, fullTime, listTime, olderOffset, outgoing, previewOf, quoteOf, replyOf, replyText, sameRow, seenSeq, sendNote, sendWait, SLOW_SEND_MS, streamingAt, viaNote, threadRows, timeLine, viewOffsetOf, type ThreadRow } from "./chatView";

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

  it("shows a lead's block that didn't fit as a card saying so, never its JSON, in the bubble and the chats list", () => {
    const fence = '```fleetd-block\n{"v":1,"kind":"table","columns":["PR",""],"rows":[]}\n```';
    const text = `The week:\n\n${fence}`;
    const parts: ChatMessage["parts"] = [{ start: 0, end: 9 }, { start: 11, end: text.length }];
    expect(bubbles({ text, message: message(text, parts) })).toEqual([
      { kind: "text", text: "The week:" },
      { kind: "block", text: "Couldn't show this" },
    ]);
    expect(previewOf({ author: "lead", text, message: message(text, parts) })).toBe("The week: Couldn't show this");
    // Past the bubble cap, blocks ride in the last bubble's text: the chats list still never shows their JSON.
    const tail = `${fence}\n\nand more\n\n${fence}`;
    expect(previewOf({ author: "lead", text: tail, message: message(tail, [{ start: 0, end: tail.length }]) })).toBe("Couldn't show this and more Couldn't show this");
    // Still streaming in: the chats list leaves the block out until the message is final.
    const streaming = { ...message("One more:\n\n```fleetd-block\n{\"v\":1,\"ki"), state: "streaming" as const };
    expect(previewOf({ author: "lead", text: streaming.text, message: streaming })).toBe("One more:");
    // A person's own fence is what they wrote: the chats list shows it as text.
    expect(previewOf({ author: "human", text: fence })).toBe('You: {"v":1,"kind":"table","columns":["PR",""],"rows":[]}');
  });
});

describe("viaNote", () => {
  it("says where a person's message came from when not the app, and nothing for the lead's", () => {
    const from = (client: string | undefined, author: ChatItem["author"] = "human") => viaNote({ author, message: { client } as ChatItem["message"] });
    expect([from("shortcuts"), from("share")]).toEqual(["via Shortcuts", "via the Share Sheet"]);
    expect([from(undefined), from("app"), from("cli"), from("shortcuts", "lead")]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("sendNote", () => {
  it("puts a line under a send only for what stays: a failure, or a lead that can't take it yet", () => {
    expect(sendNote({ state: "failed", error: { code: "invalid", message: "Too long." } })).toBe("Not sent: Too long.");
    expect(sendNote({ state: "unanswered" })).toBe("Not sent: the hub didn't answer.");
    expect(sendNote({ state: "sent", leadWaiting: "devbox is offline." })).toBe("devbox is offline.");
    // Nothing while it goes, linked or not: no line that comes and goes under each send.
    expect(sendNote({ state: "pending" })).toBeUndefined();
    expect(sendNote({ state: "queued" })).toBeUndefined();
    expect(sendNote({ state: "reconnecting" })).toBeUndefined();
    expect(sendNote({ state: "sent" })).toBeUndefined();
  });

  it("drops why the lead didn't have a message once the lead writes after it", () => {
    // Sent while devbox was offline: the hub's copy keeps saying queued after the offline queue gave it to the lead.
    const mine: ChatMessage = { ...message("node is down"), author: "human", delivery: "queued" };
    const sent: Chat = { ...emptyChat, messages: [mine], leadWaiting: { m1: "devbox is offline." } };
    const note = (chat: Chat) => sendNote(chatItems(chat, []).find((i) => i.id === "m1") ?? { state: "sent" });
    expect(note(sent)).toBe("devbox is offline.");
    const answered: Chat = { ...sent, messages: [mine, { ...message("On it."), messageId: "m2", seq: 2 }] };
    expect(note(answered)).toBeUndefined();
  });
});

describe("sendWait", () => {
  const at = "2026-11-04T10:00:00.000Z";
  const t0 = Date.parse(at);
  // What a send's row holds at each moment: the line in its layout, and the mark out of it.
  const shown = (state: ChatItem["state"], ms: number) => {
    const wait = sendWait({ state, at }, t0 + ms);
    return { note: sendNote({ state }), wait: wait?.inMs === 0 ? wait.words : undefined };
  };

  it("shows nothing for a send the hub takes quickly, and its row never changes height", () => {
    // Sent, then the hub answers 300 ms later; or the link was a moment behind (queued, then sent).
    for (const path of [["pending", "sent"], ["queued", "pending", "sent"], ["reconnecting", "sent"]] as const) {
      const frames = path.flatMap((state, i) => [0, 100, 250].map((ms) => shown(state, i * 300 + ms)));
      expect(frames.every((f) => f.note === undefined && f.wait === undefined)).toBe(true);
    }
  });

  it("marks a slow send beside its bubble after a second, never in a line under it", () => {
    expect(sendWait({ state: "pending", at }, t0 + 999)).toEqual({ words: "Sending…", inMs: 1 });
    expect(shown("pending", SLOW_SEND_MS)).toEqual({ note: undefined, wait: "Sending…" });
    expect(shown("queued", 5_000)).toEqual({ note: undefined, wait: "Not connected: it goes when the hub is back." });
    expect(shown("reconnecting", 5_000)).toEqual({ note: undefined, wait: "The link dropped: it goes again when the hub is back." });
    // Once the hub has it, or it failed, the mark goes; a failure says so in its line.
    expect(shown("sent", 5_000)).toEqual({ note: undefined, wait: undefined });
    expect(shown("failed", 5_000).wait).toBeUndefined();
    expect(shown("failed", 5_000).note).toBe("Not sent: the hub refused it.");
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
  it("groups a side's burst and puts a day line where a day starts", () => {
    const rows = threadRows([
      item("a", "human", "2026-10-28T10:00:00Z"),
      item("b", "human", "2026-10-28T10:01:00Z"),
      item("c", "lead", "2026-10-28T10:02:00Z"),
      item("d", "lead", "2026-10-28T10:20:00Z"),
      item("e", "lead", "2026-10-28T11:00:00Z"),
      item("f", "lead", "2026-10-29T08:00:00Z"),
    ], undefined, undefined, { timeZone: "UTC" });
    expect(rows.map((r) => (r.t === "item" ? `${r.id}:${r.side}:${r.first ? "F" : "-"}` : r.t))).toEqual([
      "day",
      "a:me:F",
      "b:me:-",
      "c:them:F",
      "d:them:F",
      "e:them:F",
      "day",
      "f:them:F",
    ]);
  });

  it("doesn't group two agents, and centres events", () => {
    const rows = threadRows([
      item("a", "agent", "2026-10-28T10:00:00Z", { message: { ...message("a"), author: "agent", by: "T1" } }),
      item("b", "agent", "2026-10-28T10:00:10Z", { message: { ...message("b"), author: "agent", by: "T2" } }),
      item("c", "system", "2026-10-28T10:00:20Z", { kind: "event" }),
    ]);
    expect(rows.flatMap((r) => (r.t === "item" ? [`${r.side}:${String(r.first)}`] : []))).toEqual(["them:true", "them:true", "center:true"]);
  });

  it("stamps how long the lead worked on the reply its turn ended with, and keeps it there, as the desktop's", () => {
    const worked = { since: Date.parse("2026-10-28T10:00:00Z"), until: Date.parse("2026-10-28T10:00:04Z") };
    const stamps = (rows: ThreadRow[]) => rows.flatMap((r) => (r.t === "item" && r.worked !== undefined ? [`${r.id}: ${r.worked}`] : []));
    const turn = [item("a", "human", "2026-10-28T10:00:00Z"), item("b", "lead", "2026-10-28T10:00:03Z")];
    expect(stamps(threadRows(turn, worked))).toEqual(["b: Worked for 4s"]);
    // Asked again, and the next turn's reply streaming: the stamp stays with the reply it is about.
    const next = [...turn, item("c", "human", "2026-10-28T10:01:00Z"), item("d", "lead", "2026-10-28T10:01:05Z", { state: "streaming" })];
    expect(stamps(threadRows(next, worked))).toEqual(["b: Worked for 4s"]);
    // What the lead is doing is never a row; no turn seen to its end, no stamp.
    expect(threadRows(next).map((r) => r.t)).toEqual(["day", "item", "item", "item", "item"]);
    expect(stamps(threadRows(next))).toEqual([]);
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

  it("draws a project's file block as a file card with the name, type and size the hub filled in", () => {
    const block = { v: 1, kind: "file", attachmentId: "F12", name: "lisbon-itinerary.pdf", mime: "application/pdf", bytes: 184_320 } as const;
    const parts: ChatMessage["parts"] = [{ start: 0, end: 0, block }];
    expect(bubbles({ text: "", message: message("", parts) })).toEqual([{ kind: "file", attachmentId: "F12", name: "lisbon-itinerary.pdf", mime: "application/pdf", bytes: 184_320 }]);
    expect(previewOf({ author: "lead", text: "", message: message("", parts) })).toBe("lisbon-itinerary.pdf");
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
    const rows = threadRows([item("a", 1, "lead"), item("b", 2, "human"), item("c", 3, "lead"), item("d", 4, "lead")], undefined, 1);
    expect(rows.map((r) => (r.t === "item" ? r.id : r.t))).toEqual(["day", "a", "b", "unread", "c", "d"]);
    const c = rows.find((r) => r.t === "item" && r.id === "c");
    expect(c?.t === "item" && c.first).toBe(true);
  });

  it("isn't there when everything was read, or nothing was known", () => {
    expect(threadRows([item("a", 1, "lead")], undefined, 1).some((r) => r.t === "unread")).toBe(false);
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
  const rowsOf = (chat: Chat) => threadRows(chatItems(chat, []));

  it("redraws only the streaming bubble when a word comes", () => {
    const chat = applyHistory(emptyChat, page([msg(1, "human", "Hi"), msg(2, "lead", "Hello."), msg(3, "human", "Status?"), msg(4, "lead", "Wor", "streaming")]), "latest");
    const before = rowsOf(chat);
    const after = rowsOf(applyDelta(chat, { projectRef: ref, messageId: "m4", offset: 3, append: "king on it", seq: 4 }, Date.now()));
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r, i) => sameRow(r, before[i] as ThreadRow))).toEqual([true, true, true, true, false]);
  });

  it("doesn't redraw the bubble above a new one in its burst", () => {
    const chat = applyHistory(emptyChat, page([msg(1, "lead", "One.")]), "latest");
    const next = applyHistory(chat, page([msg(1, "lead", "One."), msg(2, "lead", "Two.")]), "latest");
    const [day, one] = rowsOf(chat);
    const [day2, one2] = rowsOf(next);
    expect(sameRow(day as ThreadRow, day2 as ThreadRow)).toBe(true);
    expect(sameRow(one as ThreadRow, one2 as ThreadRow)).toBe(true);
  });
});

describe("outgoing", () => {
  const reply = { id: "m7", part: 1, quote: "Deploy it now?" };

  it("trims the words, and sends nothing with no words and no files", () => {
    expect(outgoing("  ship it \n", 0, undefined)).toEqual({ text: "ship it", replyTo: undefined });
    expect(outgoing(" \n ", 0, undefined)).toBeNull();
  });

  it("keeps a first line's indent, as of a code line, and drops only the blank lines around it", () => {
    expect(outgoing("\n\n    npm test\n    npm run lint\n  \n", 0, undefined)).toEqual({ text: "    npm test\n    npm run lint", replyTo: undefined });
    expect(outgoing("  - one\n  - two  ", 0, undefined)).toEqual({ text: "  - one\n  - two", replyTo: undefined });
  });

  it("sends a photo with no words", () => {
    expect(outgoing("  ", 1, undefined)).toEqual({ text: "", replyTo: undefined });
  });

  it("quotes the bubble a reply answers, and names it", () => {
    expect(outgoing(" yes ", 0, reply)).toEqual({ text: "> Deploy it now?\n\nyes", replyTo: { messageId: "m7", part: 1 } });
    expect(outgoing("", 1, reply)).toEqual({ text: "> Deploy it now?", replyTo: { messageId: "m7", part: 1 } });
  });

  it("a quick answer or starter passes no reply, so the banner never turns it into one", () => {
    // Chat.tsx sends an ask's button and a starter with no reply, whatever the composer quotes.
    expect(outgoing("Approve", 0, undefined)).toEqual({ text: "Approve", replyTo: undefined });
  });
});

describe("viewOffsetOf", () => {
  // VirtualizedList: offset = max(0, cell − viewPosition·(visible − length)) − viewOffset.
  const offsetOf = (cell: number, length: number, visible: number, viewPosition: number, viewOffset: number) => Math.max(0, cell - viewPosition * (visible - length)) - viewOffset;
  const visible = 800;
  const top = 116;
  const composer = 90;

  it("puts the unread bar just under the bar over the thread, not above the screen", () => {
    const cell = 2000;
    const length = 30;
    const offset = offsetOf(cell, length, visible, 1, viewOffsetOf(1, top, composer));
    // The bar's oldest edge, from the bottom of the screen: the visible length less the bar over the thread.
    expect(cell + length - offset).toBe(visible - top);
  });

  it("clears the composer at the newest end, and centres between the two", () => {
    expect(2000 - offsetOf(2000, 40, visible, 0, viewOffsetOf(0, top, composer))).toBe(composer);
    const offset = offsetOf(2000, 40, visible, 0.5, viewOffsetOf(0.5, top, composer));
    const middle = 2000 + 20 - offset;
    expect(middle).toBe((visible - top + composer) / 2);
  });

  it("lands a hit wholly between the bar and the composer, or one taller than that starting just under the bar", () => {
    // Bars and composers of any height (Dynamic Type), hits of any length, far from the newest end or right at it (its
    // cell just over the composer's spacer): the offset never goes past the newest end, and from the screen's top, the
    // hit's first line is under the bar and its last over the composer, or it starts just under the bar.
    for (const [barOver, composerUnder] of [[113, 90], [150, 140], [62, 60], [113, 200]] as const) {
      const room = visible - barOver - composerUnder;
      for (const cell of [5000, composerUnder + 4, composerUnder + 200]) {
        for (const length of [40, room / 2 + 1, room, room + 1, 2000]) {
          const aim = aimOf(0.5, length, visible, barOver, composerUnder);
          const offset = offsetOf(cell, length, visible, aim.viewPosition, aim.viewOffset);
          const hitTop = visible - (cell + length - offset);
          const hitBottom = visible - (cell - offset);
          expect(offset).toBeGreaterThanOrEqual(0);
          if (length <= room) {
            expect(hitTop).toBeGreaterThanOrEqual(barOver - 1e-9);
            expect(hitBottom).toBeLessThanOrEqual(visible - composerUnder + 1e-9);
          } else expect(hitTop).toBeCloseTo(cell === 5000 ? barOver : Math.max(barOver, visible - cell - length));
          // Far from the newest end, a hit that fits is centred between the two.
          if (cell === 5000 && length <= room) expect(hitTop - barOver).toBeCloseTo(visible - composerUnder - hitBottom);
        }
      }
    }
    // Not measured yet: as asked, with the bar and the composer as viewOffset.
    expect(aimOf(0.5, undefined, visible, 113, 90)).toEqual({ viewPosition: 0.5, viewOffset: viewOffsetOf(0.5, 113, 90) });
  });
});

describe("seenSeq", () => {
  it("is the newest message on screen", () => {
    const rows: ThreadRow[] = [
      { t: "day", id: "d", at: "2026-10-28T10:00:00Z" },
      { t: "item", id: "a", item: item("a", "lead", "2026-10-28T10:00:00Z", { message: { ...message("a"), seq: 7 } }), side: "them", first: true },
      { t: "item", id: "b", item: item("b", "human", "2026-10-28T10:01:00Z", { message: { ...message("b"), seq: 9 } }), side: "me", first: true },
      { t: "item", id: "c", item: item("c", "human", "2026-10-28T10:02:00Z"), side: "me", first: true },
      { t: "unread", id: "unread" },
    ];
    expect(seenSeq(rows)).toBe(9);
    expect(seenSeq([{ t: "unread", id: "unread" }])).toBeUndefined();
  });
});

describe("streamingAt", () => {
  const row = (id: string, state: ChatMessage["state"]): ThreadRow => ({ t: "item", id, item: item(id, "lead", "2026-10-28T10:00:00Z", { message: { ...message(id), state } }), side: "them", first: true });

  it("finds the reply streaming in at the newest end", () => {
    expect(streamingAt([row("a", "streaming"), row("b", "final")])).toBe(0);
  });

  it("is none once it's final, or when something came after it", () => {
    expect(streamingAt([row("a", "final")])).toBeUndefined();
    expect(streamingAt([row("b", "final"), row("a", "streaming")])).toBeUndefined();
    expect(streamingAt([])).toBeUndefined();
  });
});

describe("threadRows' day lines, kept per message", () => {
  it("still splits days by the clock's zone, asked again in another", () => {
    const items = [item("a", "lead", "2026-10-28T22:30:00Z"), item("b", "lead", "2026-10-29T01:30:00Z")];
    const days = (timeZone: string) => threadRows(items, undefined, undefined, { timeZone }).filter((r) => r.t === "day").length;
    expect(days("UTC")).toBe(2);
    expect(days("America/New_York")).toBe(1);
    expect(days("UTC")).toBe(2);
  });
});

describe("olderOffset", () => {
  it("goes most of a screen older from a chat opened at its newest end, before any scroll", () => {
    // Its content's length from onContentSizeChange, its offset still the 0 it opened at.
    expect(olderOffset(0, 5000, 600, 800)).toBe(510);
  });

  it("stops at the oldest end, and stays put in a thread shorter than the screen", () => {
    expect(olderOffset(4000, 5000, 600, 800)).toBe(4200);
    expect(olderOffset(0, 500, 600, 800)).toBe(0);
  });
});
