import { describe, expect, it } from "vitest";
import { MAX_ZOOM, baseScale, clampPan, clampZoom, cropOf, reach, zoomAbout } from "./crop";

const PHOTO = { width: 4000, height: 3000 };
const CIRCLE = 300;

describe("crop", () => {
  it("fills the circle with the shorter side at zoom 1", () => {
    expect(baseScale(PHOTO, CIRCLE)).toBeCloseTo(0.1);
    expect(cropOf(PHOTO, CIRCLE, 1, 0, 0)).toEqual({ x: 500, y: 0, size: 3000 });
  });

  it("moves only as far as the circle stays covered", () => {
    // 400 × 300 points at zoom 1: 50 each way across, none up or down.
    expect(reach(PHOTO, CIRCLE, 1)).toEqual({ x: 50, y: 0 });
    expect(clampPan(PHOTO, CIRCLE, 1, 80, -20)).toEqual({ x: 50, y: 0 });
    // Dragged right as far as it goes: the picture's left edge at the circle's.
    expect(cropOf(PHOTO, CIRCLE, 1, 80, 0)).toEqual({ x: 0, y: 0, size: 3000 });
    expect(cropOf(PHOTO, CIRCLE, 1, -80, 0)).toEqual({ x: 1000, y: 0, size: 3000 });
  });

  it("zooms between 1 and its most, and keeps the point under the fingers still", () => {
    expect(clampZoom(0.4)).toBe(1);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
    // A point 100 pt right of centre stays there as the zoom doubles.
    expect(zoomAbout(0, 100, 1, 2)).toBe(-100);
    expect(zoomAbout(-100, 100, 2, 2)).toBe(-100);
  });

  it("names the square under the circle when zoomed and moved", () => {
    // Zoom 2: 800 × 600 points; the circle covers 1500 px. Moved 100 pt left and 50 pt up of centre.
    expect(cropOf(PHOTO, CIRCLE, 2, -100, -50)).toEqual({ x: 1750, y: 1000, size: 1500 });
  });

  it("works for a tall picture and a tiny one", () => {
    expect(cropOf({ width: 1080, height: 1920 }, CIRCLE, 1, 0, 0)).toEqual({ x: 0, y: 420, size: 1080 });
    expect(cropOf({ width: 10, height: 10 }, CIRCLE, MAX_ZOOM, 0, 0)).toEqual({ x: 4, y: 4, size: 2 });
  });
});
