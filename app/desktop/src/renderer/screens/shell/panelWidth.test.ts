// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_MIN_PX, keyedWidth, readWidths, shownWidth, STEP_PX, widthBounds } from "./panelWidth";

afterEach(() => window.localStorage.clear());

describe("the panel's width", () => {
  it("defaults as the fixed widths did, and its max leaves the sidebar and the chat their room", () => {
    expect(widthBounds("normal", 1400)).toEqual({ min: 320, max: 800, initial: 420 });
    expect(widthBounds("normal", 2400)).toEqual({ min: 320, max: 800, initial: 520 });
    expect(widthBounds("wide", 1400)).toEqual({ min: 480, max: 800, initial: 770 });
    const small = widthBounds("normal", 1000);
    expect(small.max).toBe(1000 - 240 - CHAT_MIN_PX);
    // Too small a window for both: the min still holds.
    expect(widthBounds("wide", 900).max).toBe(480);
  });

  it("shows what you set, within bounds, else the default", () => {
    const b = widthBounds("normal", 1400);
    expect(shownWidth(null, b)).toBe(420);
    expect(shownWidth(600, b)).toBe(600);
    expect(shownWidth(100, b)).toBe(320);
    expect(shownWidth(5000, b)).toBe(800);
  });

  it("moves by the arrow keys from its left edge, four steps with Shift, to its ends with Home and End", () => {
    const b = widthBounds("normal", 1400);
    expect(keyedWidth("ArrowLeft", false, 420, b)).toBe(420 + STEP_PX);
    expect(keyedWidth("ArrowRight", false, 420, b)).toBe(420 - STEP_PX);
    expect(keyedWidth("ArrowLeft", true, 420, b)).toBe(420 + 4 * STEP_PX);
    expect(keyedWidth("ArrowRight", true, 330, b)).toBe(320);
    expect(keyedWidth("Home", false, 420, b)).toBe(320);
    expect(keyedWidth("End", false, 420, b)).toBe(800);
    expect(keyedWidth("ArrowUp", false, 420, b)).toBeNull();
  });

  it("reads back what was saved, and the defaults from nothing or junk", () => {
    expect(readWidths()).toEqual({ normal: null, wide: null });
    window.localStorage.setItem("fleetd.panel.width", JSON.stringify({ normal: 512.4, wide: "x" }));
    expect(readWidths()).toEqual({ normal: 512, wide: null });
    window.localStorage.setItem("fleetd.panel.width", "{");
    expect(readWidths()).toEqual({ normal: null, wide: null });
  });
});
