import { describe, expect, it } from "vitest";
import { parseSaved, placeWindow } from "./windowBounds";

const LIMITS = { width: 1400, height: 900, minWidth: 1024, minHeight: 700 };
const laptop = { x: 0, y: 25, width: 1512, height: 920 };
const external = { x: 1512, y: 0, width: 2560, height: 1415 };

describe("placeWindow", () => {
  it("opens at the default size, fitted to the screen, the first time", () => {
    expect(placeWindow(null, [laptop], LIMITS)).toEqual({ bounds: { width: 1400, height: 900 }, maximized: false, fullScreen: false });
    expect(placeWindow(null, [{ x: 0, y: 0, width: 1280, height: 760 }], LIMITS).bounds).toEqual({ width: 1280, height: 760 });
  });

  it("reopens where it was, maximized or full screen as it was", () => {
    const saved = { x: 2000, y: 100, width: 1600, height: 1000, maximized: true, fullScreen: false };
    expect(placeWindow(saved, [laptop, external], LIMITS)).toEqual({ bounds: { x: 2000, y: 100, width: 1600, height: 1000 }, maximized: true, fullScreen: false });
  });

  it("centres on the primary screen when its screen is gone", () => {
    const saved = { x: 2000, y: 100, width: 1600, height: 1000, maximized: false, fullScreen: true };
    expect(placeWindow(saved, [laptop], LIMITS)).toEqual({ bounds: { width: 1512, height: 920 }, maximized: false, fullScreen: true });
  });

  it("pulls a window hanging off its screen back on, and never below the minimum size", () => {
    const saved = { x: 1300, y: 100, width: 800, height: 600, maximized: false, fullScreen: false };
    expect(placeWindow(saved, [laptop], LIMITS).bounds).toEqual({ x: 488, y: 100, width: 1024, height: 700 });
    // A title bar above the top of the screen can't be grabbed, so that counts as off screen.
    expect(placeWindow({ ...saved, y: -40 }, [laptop], LIMITS).bounds).toEqual({ width: 1024, height: 700 });
  });

  it("treats a missing or hand-edited file as no saved state", () => {
    expect(parseSaved(undefined)).toBeNull();
    expect(parseSaved({ x: 1, y: 2, width: "wide", height: 3, maximized: false, fullScreen: false })).toBeNull();
    expect(parseSaved({ x: 1, y: 2, width: 3, height: 4, maximized: false, fullScreen: false })).not.toBeNull();
  });
});
