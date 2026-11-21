import { describe, expect, it } from "vitest";
import {
  asks,
  countLine,
  cursorOf,
  dayOf,
  dayRange,
  findInput,
  markedPieces,
  NO_FIND,
  NO_QUERY,
  noResults,
  othersOf,
  queryKey,
  reduceFind,
  toggleHas,
  tokensOf,
  whenRange,
  whoOf,
  withoutToken,
  wordsOf,
  type Find,
} from "./chatFind";
import type { ChatFindHit } from "./desktop";

// A fixed clock: never today's date.
const NOW = new Date(2026, 10, 18, 15, 30).getTime();

const hit = (n: number): ChatFindHit => ({ messageId: `m${String(n)}`, seq: n, createdAt: new Date(2026, 0, 1, 0, n).toISOString(), author: "lead", text: `hit ${String(n)}`, marks: [[0, 3]] });

describe("a chat's search query", () => {
  it("takes the words on one line, folded and cut to the hub's length", () => {
    expect(wordsOf("  deploy \n  failed  ")).toBe("deploy failed");
    expect(wordsOf("x".repeat(300))).toHaveLength(200);
  });

  it("asks only with words or a filter, a lone quote being neither", () => {
    expect(asks(NO_QUERY)).toBe(false);
    expect(asks({ ...NO_QUERY, words: ' " ' })).toBe(false);
    expect(asks({ ...NO_QUERY, words: "ship" })).toBe(true);
    expect(asks({ ...NO_QUERY, has: ["link"] })).toBe(true);
    expect(asks({ ...NO_QUERY, when: { t: "today" } })).toBe(true);
  });

  it("is the same search whatever order its filters were put on in", () => {
    expect(queryKey({ words: "a  b", has: ["pr", "link"] })).toBe(queryKey({ words: "a b", has: ["link", "pr"] }));
    expect(queryKey({ words: "a", has: [], from: { t: "lead" } })).not.toBe(queryKey({ words: "a", has: [] }));
  });

  it("goes to the hub with words and phrases as typed, and each filter as chat_find takes it", () => {
    expect(findInput({ words: '"merge train" stuck', has: [] }, "me", NOW)).toEqual({ words: '"merge train" stuck' });
    expect(findInput({ words: "", has: ["pr", "pinned"], from: { t: "lead" } }, "me", NOW)).toEqual({ author: "lead", has: ["pr", "pinned"] });
    expect(findInput({ words: "x", has: [], from: { t: "agents" } }, "me", NOW)).toMatchObject({ author: "agent" });
    expect(findInput({ words: "x", has: [], from: { t: "me" } }, "me", NOW)).toMatchObject({ personId: "me" });
    // A hub before people: your own words are the people's.
    expect(findInput({ words: "x", has: [], from: { t: "me" } }, undefined, NOW)).toMatchObject({ author: "human" });
    expect(findInput({ words: "x", has: [], from: { t: "person", person: { personId: "ada", name: "Ada" } } }, "me", NOW)).toMatchObject({ personId: "ada" });
  });

  it("turns a date filter into local days on the phone's clock", () => {
    const today = whenRange({ t: "today" }, NOW);
    expect(today.since).toBe(new Date(2026, 10, 18).toISOString());
    expect(today.until).toBeUndefined();
    expect(whenRange({ t: "yesterday" }, NOW)).toEqual({ since: new Date(2026, 10, 17).toISOString(), until: new Date(2026, 10, 18).toISOString() });
    expect(whenRange({ t: "week" }, NOW).since).toBe(new Date(2026, 10, 12).toISOString());
    expect(whenRange({ t: "year" }, NOW).since).toBe(new Date(2026, 0, 1).toISOString());
    expect(whenRange({ t: "day", day: "2026-03-01" }, NOW)).toEqual(dayRange("2026-03-01"));
    expect(dayRange("2026-02-28")).toEqual({ since: new Date(2026, 1, 28).toISOString(), until: new Date(2026, 2, 1).toISOString() });
    expect(dayOf(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
  });

  it("shows each filter as a token, which a tap takes off", () => {
    const q = { words: "x", has: ["pinned", "link"] as const, from: { t: "lead" } as const, when: { t: "day", day: "2026-11-03" } as const };
    const tokens = tokensOf({ ...q, has: [...q.has] }, "Inventory", NOW);
    expect(tokens.map((t) => t.label)).toEqual(["Inventory", "3 Nov", "Links", "Pinned"]);
    const first = tokens[0];
    if (first === undefined) throw new Error("no token");
    expect(withoutToken({ ...q, has: [...q.has] }, first).from).toBeUndefined();
    expect(tokensOf({ words: "", has: [], when: { t: "day", day: "2025-11-03" } }, "B", NOW)[0]?.label).toBe("3 Nov 2025");
    expect(toggleHas(toggleHas(NO_QUERY, "pr"), "pr").has).toEqual([]);
  });

  it("offers the others who wrote in the chat, each once, by name, never you", () => {
    const people = othersOf([{ person: { personId: "me", name: "Me" } }, { person: { personId: "b", name: "Bo" } }, {}, { person: { personId: "a", name: "Ada" } }, { person: { personId: "b", name: "Bo" } }], "me");
    expect(people.map((p) => p.name)).toEqual(["Ada", "Bo"]);
  });

  it("names who wrote a hit: you, another person, the bot, its agent", () => {
    expect(whoOf({ author: "human", person: { personId: "me", name: "Me" } }, "me", "Bot")).toBe("You");
    expect(whoOf({ author: "human", person: { personId: "a", name: "Ada" } }, "me", "Bot")).toBe("Ada");
    expect(whoOf({ author: "lead" }, "me", "Bot")).toBe("Bot");
    expect(whoOf({ author: "agent", by: "T12" }, "me", "Bot")).toBe("T12");
  });
});

describe("a chat's search results", () => {
  const asked = reduceFind(NO_FIND, { t: "asked", key: "k1" });

  it("reads a first page, then the next from the last hit, each hit once", () => {
    expect(asked.reading).toBe("first");
    const first = reduceFind(asked, { t: "page", key: "k1", hits: [hit(3), hit(2)], more: true, next: false, count: 3 });
    expect(first.hits).toHaveLength(2);
    expect(cursorOf(first)).toBeUndefined();
    const next = reduceFind(first, { t: "next" });
    expect(cursorOf(next)).toBe("m2");
    // Asked again while one reads: nothing more.
    expect(reduceFind(next, { t: "next" })).toBe(next);
    const all = reduceFind(next, { t: "page", key: "k1", hits: [hit(2), hit(1)], more: false, next: true });
    expect(all.hits.map((h) => h.seq)).toEqual([3, 2, 1]);
    expect(all.count).toBe(3);
    expect(reduceFind(all, { t: "next" })).toBe(all);
  });

  it("drops an answer for a search no longer asked, and keeps the hits before in view as the next one reads", () => {
    const first = reduceFind(asked, { t: "page", key: "k1", hits: [hit(1)], more: false, next: false });
    const typed = reduceFind(first, { t: "asked", key: "k2" });
    expect(typed.hits).toHaveLength(1);
    expect(reduceFind(typed, { t: "page", key: "k1", hits: [], more: false, next: false })).toBe(typed);
    expect(reduceFind(typed, { t: "failed", key: "k1", error: { code: "offline", message: "x" } })).toBe(typed);
    expect(reduceFind(typed, { t: "asked", key: "" })).toEqual(NO_FIND);
  });

  it("says how many, with a + past the hub's cap, and No Results only once a search found none", () => {
    const page = (f: Find, extra: Partial<Find>): Find => ({ ...f, reading: null, ...extra });
    expect(countLine(asked)).toBeUndefined();
    expect(countLine(page(asked, { hits: [hit(1)], count: 1 }))).toBe("1 Result");
    expect(countLine(page(asked, { hits: [hit(1)], count: 1000, countMore: true }))).toBe("1,000+ Results");
    expect(countLine(page(asked, { hits: [hit(1), hit(2)], more: false }))).toBe("2 Results");
    expect(noResults(asked)).toBe(false);
    expect(noResults(page(asked, { hits: [] }))).toBe(true);
    expect(noResults(page(asked, { hits: [], error: { code: "offline", message: "x" } }))).toBe(false);
  });

  it("marks the matched words, whatever order or overlap the marks came in", () => {
    expect(markedPieces("the deploy failed", [[11, 17], [4, 10]])).toEqual([
      { text: "the ", marked: false },
      { text: "deploy", marked: true },
      { text: " ", marked: false },
      { text: "failed", marked: true },
    ]);
    expect(markedPieces("abc", [[0, 2], [1, 3], [5, 9]])).toEqual([
      { text: "ab", marked: true },
      { text: "c", marked: true },
    ]);
    expect(markedPieces("plain", [])).toEqual([{ text: "plain", marked: false }]);
  });
});
