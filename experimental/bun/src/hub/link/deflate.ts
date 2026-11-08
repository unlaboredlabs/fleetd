// The node link's negotiated compression (`link_deflate`, crates/fleetd/src/link_deflate.rs), which /app's `deflate`
// reuses: RFC 7692 permessage-deflate done above the WebSocket. Each side keeps one Deflater for what it sends and one
// Inflater for what it receives, for the life of one link: the window carries over between messages. A compressed
// frame goes as a Binary message; a Text message is plain JSON and never touches either.
//
// node:zlib's streams are the only raw-deflate with a kept window in Bun; their work is async, so each direction runs
// its messages one at a time, in order.
import zlib from "node:zlib";

/** What RFC 7692 drops from each message's end, and the receiver puts back. */
const TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);
/** Frames this short go as Text: a heartbeat ack or an empty reply gains nothing from a binary frame. */
export const MIN_DEFLATE_BYTES = 64;

/** One zlib stream, fed a message at a time: each one's output is what came out up to its sync flush. */
class Stream {
  private chunks: Buffer[] = [];
  private size = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private failed: Error | undefined;

  constructor(
    private readonly z: zlib.DeflateRaw | zlib.InflateRaw,
    private readonly max = Number.POSITIVE_INFINITY,
  ) {
    z.on("data", (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.size += chunk.length;
    });
    z.on("error", (error: Error) => {
      this.failed = error;
    });
  }

  run(input: Buffer): Promise<Buffer> {
    const next = this.queue.then(
      () =>
        new Promise<Buffer>((resolve, reject) => {
          if (this.failed) return reject(this.failed);
          this.z.write(input);
          this.z.flush(zlib.constants.Z_SYNC_FLUSH, () => {
            const out = this.chunks.length === 1 ? (this.chunks[0] as Buffer) : Buffer.concat(this.chunks, this.size);
            const size = this.size;
            this.chunks = [];
            this.size = 0;
            if (this.failed) return reject(this.failed);
            if (size > this.max) return reject(new Error(`a compressed frame inflates past ${this.max} bytes`));
            resolve(out);
          });
        }),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  close(): void {
    this.z.close();
  }
}

/** One direction's compressor. Level 3: within a few percent of 6 on JSON, at a fraction of its CPU. */
export class Deflater {
  private readonly stream = new Stream(zlib.createDeflateRaw({ level: 3 }));

  /** `text` as one message's deflate data, its sync flush's tail removed. */
  async deflate(text: string): Promise<Buffer> {
    const out = await this.stream.run(Buffer.from(text));
    return out.length >= 4 && out.subarray(out.length - 4).equals(TAIL) ? out.subarray(0, out.length - 4) : out;
  }

  close(): void {
    this.stream.close();
  }
}

/** One direction's decompressor. */
export class Inflater {
  private readonly stream: Stream;

  /** `max`: the link's frame cap, so a small frame can't inflate to fill the hub's memory. */
  constructor(max: number) {
    this.stream = new Stream(zlib.createInflateRaw(), max);
  }

  /** One message's JSON text; rejects on corrupt data, or past `max`. Any error ends the link. */
  async inflate(data: Uint8Array): Promise<string> {
    const out = await this.stream.run(Buffer.concat([data, TAIL]));
    return out.toString("utf8");
  }

  close(): void {
    this.stream.close();
  }
}
