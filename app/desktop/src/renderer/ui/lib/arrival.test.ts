import { describe, expect, it } from "vitest";
import { arrived, noteKeys } from "./arrival";

describe("a list's arrivals", () => {
  it("counts only keys that turn up after the list's first render, once each", () => {
    noteKeys("a", ["1", "2"]);
    // Known from the start: a row a virtual list mounts later, on scroll, isn't new.
    expect(arrived("a", "2")).toBe(false);
    noteKeys("a", ["1", "2", "3"]);
    expect(arrived("a", "3")).toBe(true);
    // Remounted, it doesn't enter again.
    expect(arrived("a", "3")).toBe(false);
  });

  it("keeps each list apart, and a list never registered has no arrivals", () => {
    noteKeys("b", ["1"]);
    noteKeys("c", []);
    noteKeys("c", ["1"]);
    expect(arrived("b", "1")).toBe(false);
    expect(arrived("c", "1")).toBe(true);
    expect(arrived("d", "1")).toBe(false);
  });
});
