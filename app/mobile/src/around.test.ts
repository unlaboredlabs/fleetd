import { describe, expect, it } from "vitest";
import { farFailure, farStep, followLive, holds, joined, meets, openingWindow, pageFrom, shownWindow, windowChat, withError, withPage } from "./around";
import { emptyChat, type Chat, type ChatHistoryOutput, type ChatMessage, type ProjectChatState } from "./desktop";

const at = (seq: number): string => new Date(Date.UTC(2026, 0, 1, 0, seq)).toISOString();
const m = (seq: number, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId: `m${String(seq)}`,
  projectRef: { machineId: "devbox", projectId: "p" },
  seq,
  author: seq % 2 === 0 ? "lead" : "human",
  text: `message ${String(seq)}`,
  state: "final",
  createdAt: at(seq),
  ...extra,
});
const range = (from: number, to: number): ChatMessage[] => Array.from({ length: to - from + 1 }, (_, i) => m(from + i));
const page = (messages: ChatMessage[], moreBefore: boolean, moreAfter: boolean): ChatHistoryOutput => ({ messages, moreBefore, moreAfter, state: {} as ProjectChatState });
const chatOf = (messages: ChatMessage[]): Chat => ({ ...emptyChat, messages, hasOlder: true, loaded: true });

describe("a window around a message far back", () => {
  it("shows nothing until its page comes, then the page, and knows what it holds", () => {
    const w = openingWindow("m500");
    expect(windowChat(w).loaded).toBe(false);
    const got = withPage(w, page(range(475, 524), true, true), "around");
    expect(got.loading).toBeNull();
    expect(holds(got, "m500")).toBe(true);
    expect(windowChat(got).messages).toHaveLength(50);
    expect(windowChat(got).hasOlder).toBe(true);
  });

  it("pages from its ends, one at a time, none past an end with nothing more", () => {
    const w = withPage(openingWindow("m10"), page(range(1, 30), false, true), "around");
    expect(pageFrom(w, "older")).toBeUndefined();
    expect(pageFrom(w, "newer")).toBe(30);
    expect(pageFrom({ ...w, loading: "newer" }, "newer")).toBeUndefined();
    const newer = withPage({ ...w, loading: "newer" }, page(range(31, 60), true, true), "newer");
    // A newer page says nothing of what's before the window.
    expect(newer.moreBefore).toBe(false);
    expect(newer.messages.map((x) => x.seq)).toEqual(range(1, 60).map((x) => x.seq));
  });

  it("keeps its messages when a page fails, and says why", () => {
    const w = withPage(openingWindow("m10"), page(range(1, 30), true, true), "around");
    const failed = withError({ ...w, loading: "older" }, { code: "offline", message: "No link" });
    expect(failed.messages).toHaveLength(30);
    expect(failed.loading).toBeNull();
    expect(failed.error?.code).toBe("offline");
  });

  it("meets the chat once its newest reaches the chat's oldest held, or nothing is after it", () => {
    const chat = chatOf(range(951, 1000));
    const far = withPage(openingWindow("m500"), page(range(475, 524), true, true), "around");
    expect(meets(far, chat)).toBe(false);
    expect(meets(withPage(far, page(range(525, 950), true, true), "newer"), chat)).toBe(true);
    expect(meets(withPage(openingWindow("m990"), page(range(965, 1000), true, false), "around"), chat)).toBe(true);
    // Still reading its first page: nothing to meet with.
    expect(meets(openingWindow("m500"), chat)).toBe(false);
  });

  it("joins the chat whole: one thread down to the newest, the window's older end the chat's own", () => {
    const chat = chatOf(range(951, 1000));
    const w = withPage(openingWindow("m500"), page(range(475, 950), true, true), "around");
    const out = joined(chat, w);
    expect(out.messages[0]?.seq).toBe(475);
    expect(out.messages.at(-1)?.seq).toBe(1000);
    expect(out.messages).toHaveLength(526);
    expect(out.hasOlder).toBe(true);
    expect(out.loaded).toBe(true);
  });

  it("follows a live copy of a message it holds, and leaves it alone otherwise", () => {
    const w = withPage(openingWindow("m10"), page(range(1, 20), false, true), "around");
    const edited = followLive(w, m(10, { text: "moved", updatedAt: at(99) }));
    expect(edited.messages.find((x) => x.seq === 10)?.text).toBe("moved");
    expect(followLive(w, m(99))).toBe(w);
  });

  it("isn't drawn while its first page reads, so a hit far back waits for it rather than land on an empty thread", () => {
    const chat = chatOf(range(951, 1000));
    const opening = openingWindow("m500");
    expect(shownWindow(opening)).toBeUndefined();
    // The search hit from Info: not held, so the page around it is read, then waited for, then landed on.
    expect(farStep(chat, undefined, "m500", false)).toBe("open");
    expect(farStep(chat, opening, "m500", false)).toBe("wait");
    const got = withPage(opening, page(range(476, 525), true, true), "around");
    expect(shownWindow(got)).toBe(got);
    expect(farStep(chat, got, "m500", holds(got, "m500"))).toBe("land");
    // Another hit while a window is open: the chat holds it, so the window goes; one further back reads its own.
    expect(farStep(chat, got, "m990", false)).toBe("close");
    expect(farStep(chat, got, "m100", false)).toBe("open");
    // Held and shown already: no window at all.
    expect(farStep(chat, undefined, "m990", true)).toBe("land");
  });

  it("says a hit gone from the chat didn't open, once its page has failed", () => {
    const chat = chatOf(range(951, 1000));
    const gone = withError(openingWindow("m5"), { code: "not_found", message: "m5 is not a message of this chat." });
    expect(shownWindow(gone)).toBeUndefined();
    expect(farStep(chat, gone, "m5", false)).toBe("failed");
    expect(farFailure(gone)).toBe("It isn't in the chat any more.");
    expect(farFailure(withError(openingWindow("m5"), { code: "offline", message: "No link to the hub." }))).toBe("No link to the hub.");
  });
});
