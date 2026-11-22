// A phone screen's move in the live view (D652): its frame comes at the device's own shape, and the phone turns to a
// new shape on its side the way its orientation says, or grows or shrinks to any other.
import { describe, expect, it } from "vitest";
import { keyframesOf, moveOf, swapped, turnBetween } from "./turn";

describe("turnBetween", () => {
  it("says how far the device turned, clockwise, the short way", () => {
    expect(turnBetween("portrait", "landscape_left")).toBe(-90);
    expect(turnBetween("portrait", "landscape_right")).toBe(90);
    expect(turnBetween("landscape_left", "landscape_right")).toBe(180);
    expect(turnBetween("landscape_right", "portrait_upside_down")).toBe(90);
    expect(turnBetween("portrait_upside_down", "landscape_left")).toBe(90);
    expect(turnBetween(undefined, "portrait")).toBe(0);
    expect(turnBetween("portrait", "sideways")).toBe(0);
  });
});

describe("moveOf", () => {
  const tall = { width: 300, height: 652 };
  const wide = { width: 652, height: 300 };

  it("turns to a shape on its side, the way the device turned, from the size it stood at", () => {
    expect(swapped(tall, wide)).toBe(true);
    // Turned left (anticlockwise): played back from a quarter clockwise, the same size on its side.
    expect(moveOf(tall, wide, -90)).toEqual({ kind: "turn", degrees: 90, scale: 1 });
    // A wide stage holds it larger on its side: it starts at the size it stood at.
    expect(moveOf(tall, { width: 1304, height: 600 }, 90)).toEqual({ kind: "turn", degrees: -90, scale: 0.5 });
    // Which way unknown (no orientation): it grows to the new shape instead.
    expect(moveOf(tall, wide)?.kind).toBe("resize");
    expect(keyframesOf({ kind: "turn", degrees: 90, scale: 0.5 })).toEqual([{ transform: "rotate(90deg) scale(0.5)" }, { transform: "none" }]);
  });

  it("grows or shrinks to a new shape: a Duo opened", () => {
    const closed = { width: 300, height: 437 };
    const open = { width: 600, height: 422 };
    // Nearly its closed shape on its side: only the orientation says a phone turned.
    expect(moveOf(closed, open, 0)?.kind).toBe("resize");
    expect(moveOf(closed, open)).toEqual({ kind: "resize", scaleX: 0.5, scaleY: 1.036 });
    expect(keyframesOf({ kind: "resize", scaleX: 0.5, scaleY: 1 })).toEqual([{ transform: "scale(0.5, 1)" }, { transform: "none" }]);
  });

  it("plays nothing for the same size, or a box not laid out", () => {
    expect(moveOf(tall, { width: 300.4, height: 652 })).toBeNull();
    expect(moveOf({ width: 0, height: 0 }, tall)).toBeNull();
  });
});
