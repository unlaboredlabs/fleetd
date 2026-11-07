import { constants, createDeflateRaw, type DeflateRaw } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeUtf8, FrameInflater } from "./inflate";

/** A hub's side of one connection, as RFC 7692 has it (zlib's, as the hub's): each message sync-flushed, its tail cut. */
const deflater = (): ((text: string) => Promise<Uint8Array>) => {
  const z: DeflateRaw = createDeflateRaw({ windowBits: 15 });
  let got: Buffer[] = [];
  z.on("data", (b: Buffer) => got.push(b));
  return (text) =>
    new Promise((resolve) => {
      z.write(Buffer.from(text, "utf8"));
      z.flush(constants.Z_SYNC_FLUSH, () => {
        const all = Buffer.concat(got);
        got = [];
        expect([...all.subarray(-4)]).toEqual([0, 0, 0xff, 0xff]);
        resolve(new Uint8Array(all.subarray(0, -4)));
      });
    });
};

describe("compressed frames", () => {
  it("each message inflates to its text, the window carried across messages", async () => {
    const deflate = deflater();
    const inflater = new FrameInflater();
    const frames = [
      JSON.stringify({ t: "snapshot", projects: [{ title: "Fleet ⛵ ünïcode 😀" }], cursor: 7 }),
      JSON.stringify({ t: "event", seq: 8, type: "chat.message", data: { text: "x".repeat(20_000) } }),
      JSON.stringify({ t: "snapshot", projects: [{ title: "Fleet ⛵ ünïcode 😀" }], cursor: 9 }),
    ];
    const sizes: number[] = [];
    for (const frame of frames) {
      const bytes = await deflate(frame);
      sizes.push(bytes.length);
      expect(inflater.text(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)).toBe(frame);
    }
    // The third repeats the first, which the shared window makes almost free.
    expect(sizes[2]).toBeLessThan(sizes[0]! / 2);
  });

  it("a message that won't inflate breaks the connection's inflater for good", async () => {
    const deflate = deflater();
    const inflater = new FrameInflater();
    expect(inflater.text(new Uint8Array([0xff, 0xff, 0xff, 0x00]))).toBeNull();
    expect(inflater.text(await deflate("{}"))).toBeNull();
  });

  it("a new connection needs a new inflater: one mid-stream can't read another's", async () => {
    const first = deflater();
    await first("the first connection's opening words, which seed its window");
    const second = await first("the first connection's opening words, which seed its window");
    expect(new FrameInflater().text(second)).not.toBe("the first connection's opening words, which seed its window");
  });

  it("UTF-8 decodes without TextDecoder, past one chunk, and marks what isn't UTF-8", () => {
    const text = "ascii é ⛵ 😀 ".repeat(5000);
    expect(decodeUtf8(new Uint8Array(Buffer.from(text, "utf8")))).toBe(text);
    expect(decodeUtf8(new Uint8Array([0x61, 0xc3, 0x62]))).toBe("a�b");
  });
});
