// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { keyedWidth, STEP_PX } from "./panelWidth";
import { readSidebarWidth, SIDEBAR_DEFAULT_PX, SIDEBAR_MAX_PX, SIDEBAR_MIN_PX, sidebarBounds, sidebarWidth } from "./sidebarWidth";

afterEach(() => window.localStorage.clear());

describe("the sidebar's width", () => {
  it("defaults as the fixed width did, at most 420 px or 40% of the window, never under 200 px", () => {
    expect(SIDEBAR_DEFAULT_PX).toBe(264);
    expect(sidebarBounds(1400)).toEqual({ min: 200, max: 420, initial: 264 });
    // The app's smallest window: 40% is the smaller.
    expect(sidebarBounds(900)).toEqual({ min: 200, max: 360, initial: 264 });
    expect(sidebarBounds(1049).max).toBe(419);
    expect(sidebarBounds(1050).max).toBe(SIDEBAR_MAX_PX);
    // Too small a window for the default: it takes it in; for the min too, the min still holds.
    expect(sidebarBounds(600)).toEqual({ min: 200, max: 240, initial: 240 });
    expect(sidebarBounds(300)).toEqual({ min: SIDEBAR_MIN_PX, max: SIDEBAR_MIN_PX, initial: SIDEBAR_MIN_PX });
  });

  it("shows what you set, clamped to the window it is in, else the default", () => {
    expect(sidebarWidth(null, 1400)).toBe(264);
    expect(sidebarWidth(320, 1400)).toBe(320);
    expect(sidebarWidth(120, 1400)).toBe(200);
    expect(sidebarWidth(900, 1400)).toBe(420);
    // A narrowed window takes in a wide sidebar, and widening it gives the width you set back.
    expect(sidebarWidth(400, 900)).toBe(360);
    expect(sidebarWidth(400, 1400)).toBe(400);
  });

  it("moves by the arrow keys from its right edge: Right widens it", () => {
    const b = sidebarBounds(1400);
    expect(keyedWidth("ArrowRight", false, 264, b, "right")).toBe(264 + STEP_PX);
    expect(keyedWidth("ArrowLeft", false, 264, b, "right")).toBe(264 - STEP_PX);
    expect(keyedWidth("ArrowLeft", true, 220, b, "right")).toBe(200);
    expect(keyedWidth("ArrowRight", true, 400, b, "right")).toBe(420);
    expect(keyedWidth("Home", false, 264, b, "right")).toBe(200);
    expect(keyedWidth("End", false, 264, b, "right")).toBe(420);
  });

  it("reads back what was saved, and the default from nothing or junk", () => {
    expect(readSidebarWidth()).toBeNull();
    window.localStorage.setItem("fleetd.sidebar.width", "312.4");
    expect(readSidebarWidth()).toBe(312);
    for (const junk of ["{", '"wide"', "-5", "null"]) {
      window.localStorage.setItem("fleetd.sidebar.width", junk);
      expect(readSidebarWidth()).toBeNull();
    }
  });
});
