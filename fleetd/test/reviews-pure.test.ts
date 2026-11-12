import { expect, test } from "bun:test";
import { carries, carryOutcome, filesOf, outcomeOfRow, toolsWait } from "../src/hub/reviews/carry.ts";
import { earlierRounds, roundsAfter } from "../src/hub/reviews/comment.ts";
import { at, names, peopleFinding } from "../src/hub/reviews/findings.ts";
import { isBot, peopleQuery, readPeople } from "../src/hub/reviews/people_rules.ts";

test("a reviewer whose tools failed waits a minute, doubling, at most fifteen", () => {
  expect([1, 2, 3, 5, 20].map(toolsWait)).toEqual([60_000, 120_000, 240_000, 900_000, 900_000]);
});

test("an approval carries to a clean rebase, and is kept and read back as review_rebases holds it", async () => {
  const never = async () => {
    throw new Error("asked when it needn't be");
  };
  expect(await carryOutcome({ kind: "unchanged" }, 2, 2, 0, never)).toEqual({ kind: "unchanged" });
  expect(await carryOutcome({ kind: "conflicts", files: ["a"] }, 3, 2, 0, never)).toEqual({ kind: "changed" });
  expect(await carryOutcome({ kind: "conflicts", files: ["a"] }, 2, 2, 0, never)).toEqual({ kind: "conflicts", files: ["a"] });
  expect(await carryOutcome({ kind: "unchanged" }, 1, 2, 1, async () => false)).toEqual({ kind: "changed" });
  expect(await carryOutcome({ kind: "unchanged" }, 1, 2, 1, async () => true)).toEqual({ kind: "unchanged" });
  expect(carries({ kind: "unchanged" })).toBe(true);
  expect(outcomeOfRow("conflicts", filesOf({ kind: "conflicts", files: ["a.ts", "b.ts"] }))).toEqual({ kind: "conflicts", files: ["a.ts", "b.ts"] });
  expect(outcomeOfRow("anything", "")).toEqual({ kind: "changed" });
});

test("people's reviews are queried and read by PR, bots left out", () => {
  expect(peopleQuery([7])).toContain("p7: pullRequest(number: 7)");
  expect(isBot({ login: "dependabot[bot]" })).toBe(true);
  expect(isBot({ login: "ana", __typename: "User" })).toBe(false);
  const pull = {
    author: { login: "wr" },
    reviews: { nodes: [{ databaseId: 1, state: "CHANGES_REQUESTED", body: "Please fix", url: "u", authorAssociation: "MEMBER", author: { login: "ana" } }] },
    reviewThreads: { nodes: [] },
  };
  const read = readPeople({ repository: { p7: pull } }, [7]);
  expect(read.get(7)?.map((f) => [f.kind, f.by, f.keys])).toEqual([["changes", "ana", ["review:1"]]]);
});

test("review_read's PR names, a finding as shown, and the rounds a comment lists", () => {
  expect(names("#7", "https://github.com/acme/shop/pull/7")).toBe(true);
  expect(names("8", "https://github.com/acme/shop/pull/7")).toBe(false);
  expect(names("https://github.com/Acme/Shop/pull/7/", "https://github.com/acme/shop/pull/7")).toBe(true);
  const f = { kind: "thread", by: "ana", url: "u", path: "a.ts", line: 3, said: [], keys: [] } as never;
  expect(at(f)).toBe("a.ts:3");
  expect(peopleFinding(f)).toEqual({ by: "ana", kind: "thread", where: "a.ts:3", url: "u", said: [] });
  const r = (sha: string) => ({ sha, blocking: 0, nonBlocking: 0 });
  expect(earlierRounds([r("a"), r("b"), r("c")], "b")).toEqual([r("a"), r("c")]);
  expect(roundsAfter([r("a")], { ...r("d"), summary: "ok" })).toEqual([r("a"), r("d")]);
});
