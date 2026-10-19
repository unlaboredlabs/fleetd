import { describe, expect, it } from "vitest";
import { summarize } from "./mp4.ts";

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const box = (type: string, ...body: Array<Array<number>>): Array<number> => {
  const payload = body.flat();
  return [...u32(8 + payload.length), ...Array.from(type, (c) => c.charCodeAt(0)), ...payload];
};
const zeros = (n: number) => Array.from({ length: n }, () => 0);

// The layout Chromium's MediaRecorder writes for video/mp4: ftyp, moov (with mvex), then moof/mdat pairs, then mfra.
const avc1 = box("avc1", zeros(24), [0x05, 0x78, 0x03, 0x68], zeros(50));
const stsd = box("stsd", zeros(4), u32(1), avc1);
const moov = box("moov", box("trak", box("mdia", box("minf", box("stbl", stsd)))), box("mvex", box("trex", zeros(24))));
const fragment = (samples: number) => [...box("moof", box("traf", box("trun", zeros(4), u32(samples)))), ...box("mdat", zeros(16))];
const file = new Uint8Array([...box("ftyp", zeros(8)), ...moov, ...fragment(30), ...fragment(12), ...box("mfra", zeros(8))]);

describe("summarize", () => {
  it("reads the layout, the codec, the size and the frames", () => {
    expect(summarize(file)).toEqual({
      boxes: ["ftyp", "moov", "moof", "mdat", "moof", "mdat", "mfra"],
      codecs: ["avc1"],
      width: 1400,
      height: 872,
      frames: 42,
    });
  });

  it("refuses a box that runs past the file", () => {
    expect(() => summarize(file.slice(0, file.length - 4))).toThrow(/runs past/u);
  });
});
