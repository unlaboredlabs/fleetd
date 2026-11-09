import { describe, expect, it } from "vitest";
import { imageSize } from "./imageSize";

const b64 = (...parts: (number[] | Uint8Array)[]): string => Buffer.concat(parts.map((p) => Buffer.from(p))).toString("base64");
const be16 = (n: number) => [n >> 8, n & 255];
const be32 = (n: number) => [...be16(n >>> 16), ...be16(n & 0xffff)];
const le16 = (n: number) => [n & 255, n >> 8];
const le24 = (n: number) => [n & 255, (n >> 8) & 255, n >> 16];

const png = (w: number, h: number) => b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 2, 0, 0, 0]);

/** A JPEG's head: SOI, an APP0, an EXIF APP1 with `orientation` when given, `pad` bytes of another segment, then SOF0. */
const jpeg = (w: number, h: number, { orientation, pad = 0, little = false }: { orientation?: number; pad?: number; little?: boolean } = {}) => {
  const u16 = little ? le16 : be16;
  const exif =
    orientation === undefined
      ? []
      : (() => {
          const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...(little ? [8, 0, 0, 0] : [0, 0, 0, 8]), ...u16(1), ...u16(0x0112), ...u16(3), ...(little ? [1, 0, 0, 0] : [0, 0, 0, 1]), ...u16(orientation), 0, 0, 0, 0, 0, 0];
          const data = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
          return [0xff, 0xe1, ...be16(data.length + 2), ...data];
        })();
  const app0 = [0xff, 0xe0, ...be16(16), 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const filler = pad === 0 ? [] : [0xff, 0xe2, ...be16(pad + 2), ...new Array<number>(pad).fill(0)];
  const sof = [0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return b64([0xff, 0xd8], app0, exif, filler, sof, [0xff, 0xda]);
};

describe("a picture's size from its header", () => {
  it("reads a PNG's", () => {
    expect(imageSize(png(1200, 800))).toEqual({ width: 1200, height: 800 });
  });

  it("reads a JPEG's, past the segments before its frame, even far into the file", () => {
    expect(imageSize(jpeg(1600, 900))).toEqual({ width: 1600, height: 900 });
    expect(imageSize(jpeg(1600, 900, { pad: 20_000 }))).toEqual({ width: 1600, height: 900 });
  });

  it("turns a JPEG whose EXIF turns it a quarter, as iOS draws it", () => {
    expect(imageSize(jpeg(4032, 3024, { orientation: 6 }))).toEqual({ width: 3024, height: 4032 });
    expect(imageSize(jpeg(4032, 3024, { orientation: 8, little: true }))).toEqual({ width: 3024, height: 4032 });
    expect(imageSize(jpeg(4032, 3024, { orientation: 3 }))).toEqual({ width: 4032, height: 3024 });
  });

  it("reads a GIF's and a WebP's", () => {
    expect(imageSize(b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...le16(320), ...le16(240), 0, 0, 0]))).toEqual({ width: 320, height: 240 });
    const riff = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
    expect(imageSize(b64(riff, [0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0, ...le24(799), ...le24(599)]))).toEqual({ width: 800, height: 600 });
    expect(imageSize(b64(riff, [0x56, 0x50, 0x38, 0x20, 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(640), ...le16(480)]))).toEqual({ width: 640, height: 480 });
  });

  it("can't tell from anything else", () => {
    expect(imageSize("")).toBeUndefined();
    expect(imageSize(b64([1, 2, 3, 4, 5, 6, 7, 8]))).toBeUndefined();
    expect(imageSize(png(0, 10))).toBeUndefined();
  });
});
