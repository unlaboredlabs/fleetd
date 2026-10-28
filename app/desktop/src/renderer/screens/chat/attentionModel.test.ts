// What the line above the composer says the lead waits on you for, and where Show goes.
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/data/chat";
import type { ChatMessage } from "../../../shared/contracts";
import { countQuestions, lookingAt, lookKey, NUDGE_MS, waitingOn } from "./attentionModel";

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
const LOADED = { older: false };
const OLDER = { older: true };
const QUESTIONS = "Two calls before I ship it:\n\n1. **Copy link**: public or image only? Rec: public.\n2. **Headline**: literal or prorated? Rec: literal.";

describe("what the lead waits on", () => {
  it("counts the lead's numbered questions, and says when it asked", () => {
    expect(waitingOn([item("a", "human", "ship it"), item("b", "lead", QUESTIONS)], LOADED, NOW, "UTC")).toEqual({ what: "2 questions, asked at 09:02", targets: [{ id: "b", part: "0" }] });
    expect(waitingOn([item("b", "lead", "Looks good on your end?", at(18, 16, 40))], LOADED, NOW, "UTC")).toEqual({ what: "1 question, asked yesterday at 16:40", targets: [{ id: "b", part: "0" }] });
    expect(waitingOn([item("b", "lead", "Is it live?", at(12, 8))], LOADED, NOW, "UTC")?.what).toBe("1 question, asked Mon 12 Oct at 08:00");
  });

  it("says nothing after a plain status line, with nothing open", () => {
    expect(waitingOn([item("a", "human", "ship it"), item("b", "lead", "Done. Over to you.")], LOADED, NOW, "UTC")).toBeUndefined();
    expect(waitingOn([item("b", "lead", "Done. Over to you.")], LOADED, NOW, "UTC")).toBeUndefined();
    // Your reply answers the question before it.
    expect(waitingOn([item("a", "lead", QUESTIONS), item("h", "human", "public, literal"), item("b", "lead", "Shipped.")], LOADED, NOW, "UTC")).toBeUndefined();
  });

  it("still waits on you after a teammate writes, in a chat the team shares", () => {
    const by = (personId: string) => ({ message: { person: { personId, name: personId } } as ChatMessage });
    const items = [item("s", "human", "ship it", at(19, 8), by("P1")), item("a", "lead", QUESTIONS), item("p", "human", "looks fine to me", at(19, 9, 3), by("P2"))];
    expect(waitingOn(items, LOADED, NOW, "UTC", "P1")).toEqual({ what: "2 questions, asked at 09:02", targets: [{ id: "a", part: "0" }] });
    // The teammate's own app: their message answered it.
    expect(waitingOn(items, LOADED, NOW, "UTC", "P2")).toBeUndefined();
    // A page not loaded can't hold the wait once you wrote; a teammate writing doesn't count.
    expect(waitingOn([item("p", "human", "hi", at(19, 9), by("P2"))], OLDER, NOW, "UTC", "P1")).toEqual({ what: "a reply", targets: [] });
    // A hub from before people: every human message is yours.
    expect(waitingOn(items, LOADED, NOW, "UTC")).toBeUndefined();
  });

  it("goes to an earlier question you haven't answered, past the lead's later status lines", () => {
    const items = [item("h", "human", "go"), item("a", "lead", QUESTIONS, at(19, 8, 30)), item("b", "lead", "Merged #12.", at(19, 9, 47)), item("c", "lead", "Done. Over to you.", at(19, 9, 50))];
    expect(waitingOn(items, LOADED, NOW, "UTC")).toEqual({ what: "2 questions, asked at 08:30", targets: [{ id: "a", part: "0" }] });
  });

  it("goes to each bubble that asks, an ask block among them", () => {
    const split = (text: string, parts: ChatMessage["parts"]) => item("b", "lead", text, at(19, 9, 2), { message: { parts } as ChatMessage });
    const text = "Built it.Merge #12 now?Tag v2.4?";
    const ask = { v: 1, kind: "ask", question: "Tag v2.4" } as const;
    expect(waitingOn([split(text, [{ start: 0, end: 9 }, { start: 9, end: 23 }, { start: 23, end: 32, block: ask }])], LOADED, NOW, "UTC")).toEqual({
      what: "2 questions, asked at 09:02",
      targets: [
        { id: "b", part: "1" },
        { id: "b", part: "2" },
      ],
    });
    expect(waitingOn([split("Built it.Shipped.", [{ start: 0, end: 9 }, { start: 9, end: 17 }])], LOADED, NOW, "UTC")).toBeUndefined();
  });

  it("puts an open approval or secret first, and goes to each in turn from the oldest", () => {
    const items = [item("b", "lead", QUESTIONS), inline("g1", "gated", "open"), inline("s1", "secret", "open"), inline("g2", "gated", "open"), inline("g0", "gated", "ran")];
    expect(waitingOn(items, LOADED, NOW, "UTC")).toEqual({ what: "2 commands to approve, 1 secret to enter", targets: [{ id: "g1" }, { id: "s1" }, { id: "g2" }] });
    expect(waitingOn([inline("s1", "secret", "stored"), inline("g1", "gated", "open")], LOADED, NOW, "UTC")).toEqual({ what: "1 command to approve", targets: [{ id: "g1" }] });
    // An agent's proposed Try it setting says so.
    const setting = item("p1", "lead", "", at(19, 9, 6), {
      kind: "gated",
      message: { item: { kind: "command_approval", state: "open", previewConfig: { config: {}, why: "how it runs" } } } as unknown as ChatMessage,
    });
    expect(waitingOn([inline("g1", "gated", "open"), setting], LOADED, NOW, "UTC")).toEqual({ what: "1 command to approve, 1 Try it setting to approve", targets: [{ id: "g1" }, { id: "p1" }] });
  });

  it("counts an open approval or secret on a page not loaded, from the hub's list, and goes there too", () => {
    const open = [
      { messageId: "m3", kind: "command_approval" },
      { messageId: "s1", kind: "secret_request" },
      { messageId: "g1", kind: "command_approval" },
    ] as const;
    // You've written since, and the newest page asks nothing: m3 still waits, and Show goes to it first.
    const items = [inline("s1", "secret", "stored"), item("h", "human", "ship it"), item("b", "lead", "Done. Over to you."), inline("g1", "gated", "open")];
    expect(waitingOn(items, { older: true, open }, NOW, "UTC")).toEqual({ what: "2 commands to approve", targets: [{ id: "m3" }, { id: "g1" }] });
    // A kind from a newer hub is left out; an empty list is none.
    expect(waitingOn([item("b", "lead", "Done.")], { older: false, open: [{ messageId: "m9", kind: "something_new" }] }, NOW, "UTC")).toBeUndefined();
    expect(waitingOn([item("b", "lead", "Done.")], { older: false, open: [] }, NOW, "UTC")).toBeUndefined();
  });

  it("still says it waits when the ask isn't loaded, with nowhere to show", () => {
    expect(waitingOn([item("a", "human", "hi")], LOADED, NOW, "UTC")).toBeUndefined();
    expect(waitingOn([item("b", "lead", "Done. Over to you.")], OLDER, NOW, "UTC")).toEqual({ what: "a reply", targets: [] });
    // Older pages come before your message, so you've answered them.
    expect(waitingOn([item("a", "human", "ship it"), item("b", "lead", "Done. Over to you.")], OLDER, NOW, "UTC")).toBeUndefined();
  });

  it("reads numbered lines as questions, not numbers inside a sentence", () => {
    expect(countQuestions("1. one\n2) two\n   3. three\nnot 4. this")).toBe(3);
    expect(countQuestions("We shipped 2. Next?")).toBe(1);
    expect(countQuestions("All merged.")).toBe(0);
  });
});

describe("what there is to look at", () => {
  const nudge = (id: string, reason: string, time = at(19, 9)) => ({ messageId: id, reason, at: time });
  const flagged = (id: string, cleared?: "seen" | "dismissed") =>
    item(id, "lead", "The Machines page redesign is up.", at(19, 9), { message: { nudge: { reason: "x", at: at(19, 9), cleared } } as unknown as ChatMessage });

  it("lists the hub's waiting nudges oldest first, Show going to a loaded message's first bubble", () => {
    const looks = lookingAt([nudge("m1", "the Machines page"), nudge("m2", "Try #14: German copy")], [flagged("m1")], new Set(), NOW);
    expect(looks).toEqual([
      { id: "m1", part: "0", reason: "the Machines page", key: lookKey("m1", at(19, 9)) },
      { id: "m2", part: undefined, reason: "Try #14: German copy", key: lookKey("m2", at(19, 9)) },
    ]);
  });

  it("drops one cleared here, or that a loaded message says no longer waits", () => {
    const nudges = [nudge("m1", "one"), nudge("m2", "two"), nudge("m3", "three")];
    const looks = lookingAt(nudges, [flagged("m2", "dismissed")], new Set([lookKey("m1", at(19, 9))]), NOW);
    expect(looks.map((l) => l.id)).toEqual(["m3"]);
  });

  it("shows one flagged again after it was seen: a new flag of it, not the one cleared", () => {
    const again = [nudge("m1", "look again", at(19, 11))];
    expect(lookingAt(again, [flagged("m1", "seen")], new Set([lookKey("m1", at(19, 9))]), NOW).map((l) => l.reason)).toEqual(["look again"]);
  });

  it("fades one a day old on its own", () => {
    const flaggedAt = Date.parse(at(19, 9));
    const nudges = [nudge("m1", "one")];
    expect(lookingAt(nudges, [], new Set(), flaggedAt + NUDGE_MS - 60_000)).toHaveLength(1);
    expect(lookingAt(nudges, [], new Set(), flaggedAt + NUDGE_MS)).toEqual([]);
  });

  it("is nothing while the hub lists none", () => {
    expect(lookingAt(undefined, [flagged("m1")], new Set(), NOW)).toEqual([]);
  });
});
