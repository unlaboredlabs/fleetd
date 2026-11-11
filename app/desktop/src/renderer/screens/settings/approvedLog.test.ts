import { describe, expect, it } from "vitest";
import type { AutoApproved } from "../../../shared/contracts";
import { addPage, fold, hasMore, SHOWN, showAllWord, timesWord } from "./approvedLog";

const run = (what: string, at: string, by: AutoApproved["by"] = "yolo"): AutoApproved => ({ at, by, tool: "WebFetch", what });

describe("what ran without asking", () => {
  it("folds the same action run again in a row into one row with its count and latest time", () => {
    const rows = fold([
      run("Fetch `a.example`", "2026-10-31T16:42:00.000Z"),
      run("Fetch `a.example`", "2026-10-31T16:40:00.000Z"),
      run("Fetch `a.example`", "2026-10-31T16:38:00.000Z"),
      run("Open `b.example`", "2026-10-31T16:30:00.000Z"),
      run("Fetch `a.example`", "2026-10-31T16:20:00.000Z"),
    ]);
    expect(rows.map((r) => [r.entry.what, r.entry.at, r.count])).toEqual([
      ["Fetch `a.example`", "2026-10-31T16:42:00.000Z", 3],
      ["Open `b.example`", "2026-10-31T16:30:00.000Z", 1],
      // Not next to the others: its own row, so the log keeps its order.
      ["Fetch `a.example`", "2026-10-31T16:20:00.000Z", 1],
    ]);
    expect(rows.map((r) => timesWord(r.count))).toEqual(["3 times", undefined, undefined]);
  });

  it("keeps the checker's go and YOLO's run of the same action apart", () => {
    expect(fold([run("Open `b.example`", "2026-10-31T16:30:00.000Z", "checker"), run("Open `b.example`", "2026-10-31T16:29:00.000Z")])).toHaveLength(2);
  });

  it("offers the rest when there are more rows than the page shows, or an older page", () => {
    const five = fold(Array.from({ length: SHOWN }, (_, i) => run(`Open \`${String(i)}.example\``, "2026-10-31T16:30:00.000Z")));
    expect(hasMore(five, undefined)).toBe(false);
    expect(hasMore(five, 12)).toBe(true);
    expect(hasMore(fold([...five.map((r) => r.entry), run("Open `x.example`", "2026-10-31T16:00:00.000Z")]), undefined)).toBe(true);
    expect([showAllWord(400), showAllWord(undefined)]).toEqual(["Show all 400", "Show all"]);
  });

  it("adds an older page after what was read, its cursor the next", () => {
    const a = run("Open `a.example`", "2026-10-31T16:30:00.000Z");
    const b = run("Open `b.example`", "2026-10-31T16:00:00.000Z");
    expect(addPage({ log: [a], older: 7 }, { log: [b] })).toEqual({ log: [a, b], older: undefined });
  });
});
