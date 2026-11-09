// The link's negotiated compression: RFC 7692 permessage-deflate done above the
// WebSocket. One raw-DEFLATE stream per direction per link with context takeover; each message is sync-flushed and its
// trailing `00 00 ff ff` dropped (the receiver puts it back). Frames shorter than MIN_DEFLATE_BYTES go as Text.
import zlib from "node:zlib";

const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);
export const MIN_DEFLATE_BYTES = 64;

/** One zlib stream fed a message at a time, each answered with what its sync flush wrote. Calls run in order. */
class Flushed {
  #chunks: Buffer[] = [];
  #size = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #error: Error | undefined;
  /** The push waiting on its flush: an error rejects it, as zlib then never calls the flush back. */
  #pending: ((error: Error) => void) | undefined;
  constructor(
    readonly stream: zlib.DeflateRaw | zlib.InflateRaw,
    readonly max = Number.POSITIVE_INFINITY,
  ) {
    stream.on("data", (chunk: Buffer) => {
      this.#chunks.push(chunk);
      this.#size += chunk.length;
    });
    stream.on("error", (error: Error) => {
      this.#error = error;
      this.#pending?.(error);
      this.#pending = undefined;
    });
  }

  push(input: Buffer): Promise<Buffer> {
    const run = this.#queue.then(
      () =>
        new Promise<Buffer>((resolve, reject) => {
          if (this.#error) return reject(this.#error);
          this.#pending = reject;
          this.stream.write(input);
          this.stream.flush(zlib.constants.Z_SYNC_FLUSH, () => {
            this.#pending = undefined;
            const out = Buffer.concat(this.#chunks, this.#size);
            this.#chunks = [];
            this.#size = 0;
            if (this.#error) reject(this.#error);
            else if (out.length > this.max) reject(new Error(`a compressed frame inflates past ${this.max} bytes`));
            else resolve(out);
          });
        }),
    );
    this.#queue = run.catch(() => {});
    return run;
  }

  close(): void {
    this.stream.destroy();
  }
}

/** One direction's compressor (level 3, as the Rust link's). */
export class Deflater {
  #s = new Flushed(zlib.createDeflateRaw({ level: 3 }));
  async deflate(text: string): Promise<Buffer> {
    const out = await this.#s.push(Buffer.from(text, "utf8"));
    return out.subarray(out.length - 4).equals(TAIL) ? out.subarray(0, out.length - 4) : out;
  }
  close(): void {
    this.#s.close();
  }
}

/** One direction's decompressor: a message's JSON text, or a rejection that ends the link (its window is lost). */
export class Inflater {
  #s: Flushed;
  constructor(max: number) {
    this.#s = new Flushed(zlib.createInflateRaw(), max);
  }
  async inflate(data: Uint8Array): Promise<string> {
    let out: Buffer;
    try {
      out = await this.#s.push(Buffer.concat([data, TAIL]));
    } catch (error) {
      const why = (error as Error).message;
      throw new Error(why.includes("inflates past") ? why : `a compressed frame does not inflate: ${why}`);
    }
    const text = new TextDecoder("utf-8", { fatal: true });
    try {
      return text.decode(out);
    } catch {
      throw new Error("a compressed frame is not UTF-8");
    }
  }
  close(): void {
    this.#s.close();
  }
}
