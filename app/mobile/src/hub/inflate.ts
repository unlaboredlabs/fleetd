// The /app socket's compressed frames, read: a hub that lists "deflate" in `ready` may send any frame after it as a
// Binary message, RFC 7692's permessage-deflate payload (one raw DEFLATE stream per connection, its window carried from
// message to message, each message sync-flushed with its trailing 00 00 ff ff taken off). Hermes has no zlib, so pako
// inflates, one inflater per connection, every message in order. Text frames still come as they are.
import { Inflate, Z_SYNC_FLUSH } from "pako";

/** The `auth` and `ready` feature that says the sender reads compressed frames. */
export const DEFLATE_FEATURE = "deflate";
/** One message never inflates past this: a frame that would is the link's fault, which is dropped. */
export const INFLATE_MAX_BYTES = 64 * 1024 * 1024;

const TAIL = new Uint8Array([0, 0, 0xff, 0xff]);

/** UTF-8 to text: Hermes may have no TextDecoder. Sequences that aren't UTF-8 come out as U+FFFD, as TextDecoder's. */
export const decodeUtf8 = (bytes: Uint8Array): string => {
  const units: number[] = [];
  let out = "";
  const flush = () => {
    out += String.fromCharCode.apply(null, units);
    units.length = 0;
  };
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    const n = b < 0x80 ? 0 : b >> 5 === 6 ? 1 : b >> 4 === 14 ? 2 : b >> 3 === 30 ? 3 : -1;
    let cp = n === 0 ? b : b & (0x3f >> n);
    let ok = n >= 0 && i + n < bytes.length;
    for (let k = 1; ok && k <= n; k++) {
      const c = bytes[i + k]!;
      ok = c >> 6 === 2;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (ok && ((n === 1 && cp < 0x80) || (n === 2 && cp < 0x800) || (n === 3 && cp < 0x10000) || cp > 0x10ffff || (cp >= 0xd800 && cp < 0xe000))) ok = false;
    if (!ok) {
      units.push(0xfffd);
      i += 1;
    } else {
      if (cp < 0x10000) units.push(cp);
      else units.push(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff));
      i += n + 1;
    }
    if (units.length >= 8192) flush();
  }
  flush();
  return out;
};

/** One connection's inflater: each Binary message to its text, in order; null when it won't inflate. */
export class FrameInflater {
  readonly #inflate = new Inflate({ raw: true, windowBits: 15 });
  #chunks: Uint8Array[] = [];
  #size = 0;
  #broken = false;

  constructor() {
    this.#inflate.onData = (chunk: Uint8Array) => {
      this.#size += chunk.length;
      // pako reuses nothing it hands out on a flush, but a full chunk's buffer may be: keep a copy.
      if (this.#size <= INFLATE_MAX_BYTES) this.#chunks.push(chunk.slice());
    };
  }

  text(message: ArrayBuffer | Uint8Array): string | null {
    if (this.#broken) return null;
    const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
    const input = new Uint8Array(bytes.length + TAIL.length);
    input.set(bytes);
    input.set(TAIL, bytes.length);
    this.#chunks = [];
    this.#size = 0;
    this.#inflate.push(input, Z_SYNC_FLUSH);
    if (this.#inflate.err !== 0 || this.#inflate.ended || this.#size > INFLATE_MAX_BYTES) {
      this.#broken = true;
      return null;
    }
    const whole = this.#chunks.length === 1 ? this.#chunks[0]! : new Uint8Array(this.#size);
    if (this.#chunks.length !== 1) {
      let at = 0;
      for (const chunk of this.#chunks) {
        whole.set(chunk, at);
        at += chunk.length;
      }
    }
    this.#chunks = [];
    return decodeUtf8(whole);
  }
}
