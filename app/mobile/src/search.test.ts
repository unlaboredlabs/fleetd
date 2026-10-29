import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./desktop";
import { matchesName, queryOf, searchMessages, snippetOf } from "./search";

const m = (messageId: string, text: string, createdAt: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  messageId,
  projectRef: { machineId: "m", projectId: "p" },
  seq: 1,
  author: "lead",
  text,
  state: "final",
  createdAt,
  ...extra,
});

describe("search", () => {
  it("trims and folds the query, and matches names in any case", () => {
    expect(queryOf("  ship   it ")).toBe("ship it");
    expect(matchesName("Billing API", "api")).toBe(true);
    expect(matchesName("Billing API", "")).toBe(false);
  });

  it("finds words in markdown as plain text, with the match marked", () => {
    const hit = snippetOf("The **deploy** finished", "DEPLOY");
    expect(hit).toEqual({ snippet: "The deploy finished", match: [4, 10] });
    expect(snippetOf("Nothing here", "deploy")).toBeUndefined();
  });

  it("cuts a long message's start so the match shows near the front", () => {
    const hit = snippetOf(`${"word ".repeat(20)}needle at the end`, "needle");
    expect(hit?.snippet.startsWith("…")).toBe(true);
    expect(hit?.snippet.slice(hit.match[0], hit.match[1])).toBe("needle");
  });

  it("lists every chat's matches newest first, each message once, never one still streaming", () => {
    const a = m("1", "deploy staging", "2026-10-28T10:00:00Z");
    const b = m("2", "deploy prod", "2026-10-28T11:00:00Z");
    const live = m("3", "deploy…", "2026-10-28T12:00:00Z", { state: "streaming" });
    const hits = searchMessages({ "m/p": [a, b, live], "m/q": [a] }, "deploy");
    expect(hits.map((h) => h.messageId)).toEqual(["2", "1"]);
    expect(searchMessages({ "m/p": [a] }, "")).toEqual([]);
  });
});
