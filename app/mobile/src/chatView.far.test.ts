// A chat opened at a message far back (chatView.ts FarWindow), on the desktop's window (desktop.ts openWindow,
// pageWindow, windowJoins, joinWindow).
import { describe, expect, it } from "vitest";
import { farFailed, farFailure, farJoins, farLoading, farOpening, farPage, farPageFrom, farStep, followLive, openingFar, shownWindow, windowChat } from "./chatView";
import { emptyChat, holds, joinWindow, type Chat, type ChatHistoryOutput, type ChatMessage, type ProjectChatState } from "./desktop";

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
  it("shows nothing until its page comes, then the page, as a chat the thread draws", () => {
    const opening = openingFar("m500");
    expect(farOpening(opening)).toBe(true);
    expect(shownWindow(opening)).toBeUndefined();
    const got = farPage(opening, page(range(475, 524), true, true), "around");
    expect(farOpening(got)).toBe(false);
    const w = shownWindow(got);
    expect(w?.at).toBe("m500");
    if (w === undefined) throw new Error("no window");
    expect(holds(windowChat(w), "m500")).toBe(true);
    expect(windowChat(w)).toMatchObject({ hasOlder: true, loaded: true });
    expect(windowChat(w).messages).toHaveLength(50);
  });

  it("pages from its ends, one at a time, none past an end with nothing more", () => {
    const w = farPage(openingFar("m10"), page(range(1, 30), false, true), "around");
    expect(farPageFrom(w, "older")).toBeUndefined();
    expect(farPageFrom(w, "newer")).toBe(30);
    const loading = farLoading(w, "newer");
    expect(farPageFrom(loading, "newer")).toBeUndefined();
    const newer = farPage(loading, page(range(31, 60), true, true), "newer");
    // A newer page says nothing of what's before the window.
    expect(newer.window?.hasOlder).toBe(false);
    expect(newer.window?.loadingNewer).toBe(false);
    expect(newer.window?.messages.map((x) => x.seq)).toEqual(range(1, 60).map((x) => x.seq));
  });

  it("keeps its messages when a page fails, and says why and at which end", () => {
    const w = farPage(openingFar("m10"), page(range(1, 30), true, true), "around");
    const failed = farFailed(farLoading(w, "newer"), "newer", { code: "offline", message: "No link" });
    expect(failed.window?.messages).toHaveLength(30);
    expect(failed.window?.loadingNewer).toBe(false);
    expect(failed.error).toEqual({ end: "newer", error: { code: "offline", message: "No link" } });
    // The next page asked for goes on from where it was.
    expect(farPageFrom(failed, "newer")).toBe(30);
    expect(farPage(failed, page(range(31, 40), true, true), "newer").error).toBeUndefined();
  });

  it("joins the chat once its newest reaches the chat's oldest held, or nothing is after it: one thread to the newest", () => {
    const chat = chatOf(range(951, 1000));
    const far = farPage(openingFar("m500"), page(range(475, 524), true, true), "around");
    expect(farJoins(far, chat)).toBe(false);
    const reached = farPage(far, page(range(525, 950), true, true), "newer");
    expect(farJoins(reached, chat)).toBe(true);
    expect(farJoins(farPage(openingFar("m990"), page(range(965, 1000), true, false), "around"), chat)).toBe(true);
    // Still reading its first page, or the chat's own page not in yet: nothing to join.
    expect(farJoins(openingFar("m500"), chat)).toBe(false);
    expect(farJoins(reached, { ...chat, loaded: false })).toBe(false);
    if (reached.window === undefined) throw new Error("no window");
    const out = joinWindow(chat, reached.window);
    expect(out.messages[0]?.seq).toBe(475);
    expect(out.messages.at(-1)?.seq).toBe(1000);
    expect(out.messages).toHaveLength(526);
    expect(out.hasOlder).toBe(true);
  });

  it("follows a live copy of a message it holds, and leaves it alone otherwise", () => {
    const w = farPage(openingFar("m10"), page(range(1, 20), false, true), "around");
    const edited = followLive(w, m(10, { text: "moved", updatedAt: at(99) }));
    expect(edited.window?.messages.find((x) => x.seq === 10)?.text).toBe("moved");
    expect(followLive(w, m(99))).toBe(w);
    expect(followLive(openingFar("m10"), m(10))).toEqual(openingFar("m10"));
  });

  it("isn't drawn while its first page reads, so a hit far back waits for it rather than land on an empty thread", () => {
    const chat = chatOf(range(951, 1000));
    const opening = openingFar("m500");
    // The search hit from Info: not held, so the page around it is read, then waited for, then landed on.
    expect(farStep(chat, undefined, "m500", false)).toBe("open");
    expect(farStep(chat, opening, "m500", false)).toBe("wait");
    const got = farPage(opening, page(range(476, 525), true, true), "around");
    expect(farStep(chat, got, "m500", true)).toBe("land");
    // Another hit while a window is open: the chat holds it, so the window goes; one further back reads its own.
    expect(farStep(chat, got, "m990", false)).toBe("close");
    expect(farStep(chat, got, "m100", false)).toBe("open");
    // Held and shown already: no window at all.
    expect(farStep(chat, undefined, "m990", true)).toBe("land");
  });

  it("says a hit gone from the chat didn't open, once its page has failed", () => {
    const chat = chatOf(range(951, 1000));
    const gone = farFailed(openingFar("m5"), "around", { code: "not_found", message: "m5 is not a message of this chat." });
    expect(farOpening(gone)).toBe(false);
    expect(shownWindow(gone)).toBeUndefined();
    expect(farStep(chat, gone, "m5", false)).toBe("failed");
    expect(farFailure(gone)).toBe("It isn't in the chat any more.");
    expect(farFailure(farFailed(openingFar("m5"), "around", { code: "offline", message: "No link to the hub." }))).toBe("No link to the hub.");
  });
});
