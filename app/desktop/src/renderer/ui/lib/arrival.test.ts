import { describe, expect, it } from "vitest";
import { arrived, forgetList, FRESH_MS, noteKeys } from "./arrival";

describe("a list's arrivals", () => {
  it("counts only keys that turn up after the list's first render, once each", () => {
    noteKeys("a", ["1", "2"], 0);
    // Known from the start: a row a virtual list mounts later, on scroll, isn't new.
    expect(arrived("a", "2", 10)).toBe(false);
    noteKeys("a", ["1", "2", "3"], 100);
    expect(arrived("a", "3", 200)).toBe(true);
    // Remounted, it doesn't enter again.
    expect(arrived("a", "3", 300)).toBe(false);
  });

  it("lets a new row enter only soon after its key came: scrolled to later, it is still", () => {
    noteKeys("late", ["1"], 0);
    noteKeys("late", ["1", "2", "3"], 100);
    expect(arrived("late", "2", 100 + FRESH_MS + 1)).toBe(false);
    // A later render drops what no row took in time.
    noteKeys("late", ["1", "2", "3"], 100 + FRESH_MS + 1);
    expect(arrived("late", "3", 100 + FRESH_MS + 2)).toBe(false);
  });

  it("forgets keys that left, so one coming back is new again, and a list shown anew has nothing new", () => {
    noteKeys("b", ["1", "2"], 0);
    noteKeys("b", ["1"], 10);
    noteKeys("b", ["1", "2"], 20);
    expect(arrived("b", "2", 30)).toBe(true);
    // Reopened (its record dropped on unmount): what it holds is known.
    forgetList("b");
    noteKeys("b", ["1", "2", "4"], 40);
    expect(arrived("b", "4", 50)).toBe(false);
  });

  it("keeps each list apart, and a list never registered has no arrivals", () => {
    noteKeys("c", ["1"], 0);
    noteKeys("d", [], 0);
    noteKeys("d", ["1"], 10);
    expect(arrived("c", "1", 20)).toBe(false);
    expect(arrived("d", "1", 20)).toBe(true);
    expect(arrived("e", "1", 20)).toBe(false);
  });
});
