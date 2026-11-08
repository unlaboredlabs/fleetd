// An image sent with a message shows at its size in points, within IMAGE_MAX, keeping its shape: a small one as it is,
// a wide or tall one shrunk to the box, a Retina screenshot at half its pixels.
import { expect, it } from "vitest";
import { IMAGE_MAX, imageFit, looksText, pngDensity } from "./attachments";

/** A PNG's head: the signature, IHDR, then pHYs at `ppm` pixels per metre when given (CRCs left zero). */
const png = (width: number, height: number, ppm?: number): string => {
  const chunk = (type: string, data: number[]) => {
    const len = data.length;
    return [len >>> 24, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...Array.from({ length: 4 }, (_, i) => type.charCodeAt(i)), ...data, 0, 0, 0, 0];
  };
  const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [...u32(width), ...u32(height), 8, 6, 0, 0, 0]),
    ...(ppm === undefined ? [] : chunk("pHYs", [...u32(ppm), ...u32(ppm), 1])),
    ...chunk("IDAT", [0]),
  ];
  return btoa(String.fromCharCode(...bytes));
};

it("reads a Retina screenshot's density from its pHYs chunk, and 1 from anything else", () => {
  expect(pngDensity(png(2880, 1800, 5669))).toBe(2);
  expect(pngDensity(png(800, 600, 2835))).toBe(1);
  expect(pngDensity(png(800, 600, 3780))).toBe(1);
  expect(pngDensity(png(800, 600))).toBe(1);
  expect(pngDensity("not base64 at all!")).toBe(1);
  expect(pngDensity(btoa("GIF89a......"))).toBe(1);
});

it("fits a small, a wide, a tall and a Retina image in the box, keeping their shape", () => {
  // Small: as it is.
  expect(imageFit(120, 80)).toEqual({ width: 120, height: 80 });
  // Wide: as wide as the box.
  expect(imageFit(1600, 400)).toEqual({ width: IMAGE_MAX.width, height: 90 });
  // Tall: as tall as the box.
  expect(imageFit(400, 1600)).toEqual({ width: 70, height: IMAGE_MAX.height });
  // A 2x screenshot of 300 × 100 points shows at 300 × 100, not at its 600 pixels.
  expect(imageFit(600, 200, 2)).toEqual({ width: 300, height: 100 });
  // Nothing known yet: the box.
  expect(imageFit(0, 0)).toEqual(IMAGE_MAX);
});

it("calls a file text as the hub does: no NUL byte, or UTF-16's mark", () => {
  const bytes = (...b: number[]) => new Uint8Array(b).buffer;
  // Valid UTF-8, but a NUL says binary: the hub refuses it as text, so it isn't offered as text.
  expect(looksText(bytes(0x00, 0x01, 0x62, 0x69, 0x6e))).toBe(false);
  // Windows-1252 ("café" from a bank's export) and UTF-16 with its mark are text the hub takes.
  expect(looksText(bytes(0x63, 0x61, 0x66, 0xe9))).toBe(true);
  expect(looksText(bytes(0xff, 0xfe, 0x61, 0x00, 0x62, 0x00))).toBe(true);
  expect(looksText(new TextEncoder().encode("plain words\n").buffer)).toBe(true);
});
