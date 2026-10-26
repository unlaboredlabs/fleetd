import { describe, expect, it } from "vitest";
import { framePoint, keyInput, modifiersOf } from "./live";

const keys = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe("a person's input to a page they took over", () => {
  it("is in the frame's own pixels, wherever the frame is drawn and at whatever size", () => {
    expect(framePoint(150, 90, { left: 100, top: 40, width: 320, height: 200 }, { width: 1280, height: 800 })).toEqual({ x: 200, y: 200 });
  });

  it("carries the modifiers as CDP counts them", () => {
    expect(modifiersOf({ ...keys, altKey: true, shiftKey: true })).toBe(9);
    expect(modifiersOf({ ...keys, ctrlKey: true, metaKey: true })).toBe(6);
  });

  it("types a printable key's character, and nothing for a shortcut or a release", () => {
    expect(keyInput({ ...keys, key: "a", code: "KeyA" }, "down")).toEqual({ kind: "key", action: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 });
    expect(keyInput({ ...keys, key: "v", code: "KeyV", metaKey: true }, "down")).toEqual({ kind: "key", action: "down", key: "v", code: "KeyV", modifiers: 4 });
    expect(keyInput({ ...keys, key: "Enter", code: "Enter" }, "down")).not.toHaveProperty("text");
    expect(keyInput({ ...keys, key: "a", code: "KeyA" }, "up")).not.toHaveProperty("text");
  });
});
