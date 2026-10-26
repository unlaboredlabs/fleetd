import { describe, expect, it } from "vitest";
import { leavers, withLeavers } from "./leaving";

const key = (s: string) => s;

describe("rows leaving a list", () => {
  it("puts what left back where it was, marked leaving", () => {
    const gone = leavers(["a", "b", "c", "d"], ["a", "c"], key);
    expect(gone).toEqual([
      { item: "b", index: 1 },
      { item: "d", index: 3 },
    ]);
    expect(withLeavers(["a", "c"], gone)).toEqual([
      { item: "a", leaving: false },
      { item: "b", leaving: true },
      { item: "c", leaving: false },
      { item: "d", leaving: true },
    ]);
  });

  it("keeps what was already leaving, unless it came back", () => {
    const first = leavers(["a", "b", "c"], ["a", "c"], key);
    expect(leavers(["a", "c"], ["a"], key, first).map((g) => g.item)).toEqual(["b", "c"]);
    expect(leavers(["a", "c"], ["a", "b", "c"], key, first)).toEqual([]);
  });

  it("leaves a list nothing left from as it is", () => {
    expect(withLeavers(["a", "b"], leavers(["a", "b"], ["a", "b"], key))).toEqual([
      { item: "a", leaving: false },
      { item: "b", leaving: false },
    ]);
  });
});
