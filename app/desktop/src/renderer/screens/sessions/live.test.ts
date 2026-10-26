import { describe, expect, it } from "vitest";
import { framePoint, isPaste, keyInput, modifiersOf } from "./live";

const keys = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe("a person's input to a page they took over", () => {
  it("is in the frame's own pixels, wherever the frame is drawn and at whatever size", () => {
    expect(framePoint(150, 90, { left: 100, top: 40, width: 320, height: 200 }, { width: 1280, height: 800 })).toEqual({ x: 200, y: 200 });
  });

  it("carries the modifiers as CDP counts them", () => {
    expect(modifiersOf({ ...keys, altKey: true, shiftKey: true })).toBe(9);
    expect(modifiersOf({ ...keys, ctrlKey: true, metaKey: true })).toBe(6);
  });

  it("takes ⌘V (Ctrl+V elsewhere) as a paste of this computer's clipboard, not as a key for the page", () => {
    const v = { key: "v", code: "KeyV" };
    expect(isPaste({ ...keys, ...v, metaKey: true }, "darwin")).toBe(true);
    expect(isPaste({ ...keys, ...v, ctrlKey: true }, "linux")).toBe(true);
    // An upper-case V, and a layout that types another letter on the V key.
    expect(isPaste({ ...keys, key: "V", code: "KeyV", ctrlKey: true }, "linux")).toBe(true);
    expect(isPaste({ ...keys, key: "м", code: "KeyV", metaKey: true }, "darwin")).toBe(true);
    // Not the other platform's modifier, not with Alt, not a plain v.
    expect(isPaste({ ...keys, ...v, ctrlKey: true }, "darwin")).toBe(false);
    expect(isPaste({ ...keys, ...v, metaKey: true, altKey: true }, "darwin")).toBe(false);
    expect(isPaste({ ...keys, ...v }, "linux")).toBe(false);
  });

  it("types a printable key's character, and nothing for a shortcut or a release", () => {
    expect(keyInput({ ...keys, key: "a", code: "KeyA" }, "down")).toEqual({ kind: "key", action: "down", key: "a", code: "KeyA", text: "a", modifiers: 0 });
    expect(keyInput({ ...keys, key: "v", code: "KeyV", metaKey: true }, "down")).toEqual({ kind: "key", action: "down", key: "v", code: "KeyV", modifiers: 4 });
    expect(keyInput({ ...keys, key: "Enter", code: "Enter" }, "down")).not.toHaveProperty("text");
    expect(keyInput({ ...keys, key: "a", code: "KeyA" }, "up")).not.toHaveProperty("text");
  });
});
