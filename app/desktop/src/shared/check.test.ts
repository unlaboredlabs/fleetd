// The plain checks the hub client's frames and the web's session go through (they replaced zod's schemas, with the
// same rules): the edges each rule draws. A frame's checks are protocol.test.ts's.
import { describe, expect, it } from "vitest";
import { isFields, isInt, isList, isOptional, isText } from "./check";

describe("the plain checks", () => {
  it("draw each rule's edge as the schemas did", () => {
    expect(isText("ab", 1, 2)).toBe(true);
    expect(isText("abc", 1, 2)).toBe(false);
    expect(isText("", 1)).toBe(false);
    expect(isText(1)).toBe(false);
    expect(isInt(0, 0)).toBe(true);
    expect(isInt(-1, 0)).toBe(false);
    expect(isInt(1.5)).toBe(false);
    expect(isInt(2 ** 53)).toBe(false);
    expect(isInt("1")).toBe(false);
    expect(isList(["a"], 1, (x): x is string => typeof x === "string")).toBe(true);
    expect(isList(["a", "b"], 1, (x): x is string => typeof x === "string")).toBe(false);
    expect(isOptional(undefined, isFields)).toBe(true);
    expect(isOptional(null, isFields)).toBe(false);
    expect(isFields([])).toBe(false);
  });
});
