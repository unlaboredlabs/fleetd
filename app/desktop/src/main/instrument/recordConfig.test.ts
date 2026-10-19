import { describe, expect, it } from "vitest";
import { bitrateFor, keyDelayMs, parseRecord } from "./recordConfig";

describe("FLEETD_RECORD", () => {
  it("parses a directory and an optional rate, as the GPUI app did", () => {
    expect(parseRecord("/tmp/rec")).toEqual({ ok: true, value: { dir: "/tmp/rec", fps: 30 } });
    expect(parseRecord("/tmp/rec,60")).toEqual({ ok: true, value: { dir: "/tmp/rec", fps: 60 } });
    expect(parseRecord("/tmp/a,b/rec, 24")).toEqual({ ok: true, value: { dir: "/tmp/a,b/rec", fps: 24 } });
    expect(parseRecord("/tmp/rec,0")).toMatchObject({ ok: false, error: expect.stringContaining("1-120") as string });
    expect(parseRecord("/tmp/rec,fast")).toMatchObject({ ok: false, error: expect.stringContaining("not a frame rate") as string });
    expect(parseRecord(",30")).toMatchObject({ ok: false, error: expect.stringContaining("no directory") as string });
  });

  it("keeps the bitrate between 4 and 24 Mbit/s", () => {
    expect(bitrateFor(2800, 1744, 30)).toBe(12_208_000);
    expect(bitrateFor(320, 200, 30)).toBe(4_000_000);
    expect(bitrateFor(3840, 2400, 120)).toBe(24_000_000);
  });

  it("types at a person's pace, pausing after words and sentences", () => {
    expect(keyDelayMs(0, "a")).toBe(30);
    expect(keyDelayMs(1, " ")).toBe(30 + 39 + 40);
    expect(keyDelayMs(2, ".")).toBe(30 + (15_838 % 40) + 180);
  });
});
