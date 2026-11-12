// A zip archive read by hand (stored or deflated entries only), bounded however the file is built: each entry inflates
// to at most ENTRY_MAX. The hub reads an Office file's XML with it (office.ts); the hosted service an .apk inside a
// GitHub artifact (`bytes`).

/** The most one entry of the archive inflates to: a zip bomb stops here. */
export const ENTRY_MAX = 64 * 1024 * 1024;

const u16At = (b: Uint8Array, at: number) => (at + 2 <= b.length ? b[at]! | (b[at + 1]! << 8) : undefined);
const u32At = (b: Uint8Array, at: number) =>
  at + 4 <= b.length ? (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0 : undefined;
const sig = (b: Uint8Array, at: number, s: readonly number[]) => at >= 0 && at + s.length <= b.length && s.every((x, i) => b[at + i] === x);

const EOCD = [0x50, 0x4b, 0x05, 0x06];
const CENTRAL = [0x50, 0x4b, 0x01, 0x02];
const LOCAL = [0x50, 0x4b, 0x03, 0x04];

/** A zip archive's entries, by name: each one's compression method, compressed size and local header's offset. */
export class Zip {
  private constructor(
    private readonly archive: Uint8Array,
    private readonly entries: { name: string; method: number; size: number; local: number }[],
  ) {}

  static open(bytes: Uint8Array): Zip | undefined {
    if (bytes.length < 22) return undefined;
    // The end-of-directory record sits in the last 64 KiB and some.
    const from = Math.max(0, bytes.length - (22 + 65_535));
    let end = -1;
    for (let at = bytes.length - 22; at >= from; at--) {
      if (sig(bytes, at, EOCD)) {
        end = at;
        break;
      }
    }
    if (end < 0) return undefined;
    const count = u16At(bytes, end + 10);
    let at = u32At(bytes, end + 16);
    if (count === undefined || at === undefined) return undefined;
    const entries: { name: string; method: number; size: number; local: number }[] = [];
    const latin = new TextDecoder("utf-8");
    for (let i = 0; i < count; i++) {
      if (!sig(bytes, at, CENTRAL)) return undefined;
      const method = u16At(bytes, at + 10);
      const size = u32At(bytes, at + 20);
      const nameLen = u16At(bytes, at + 28);
      const extra = u16At(bytes, at + 30);
      const comment = u16At(bytes, at + 32);
      const local = u32At(bytes, at + 42);
      if (method === undefined || size === undefined || nameLen === undefined || extra === undefined || comment === undefined || local === undefined) {
        return undefined;
      }
      if (at + 46 + nameLen > bytes.length) return undefined;
      entries.push({ name: latin.decode(bytes.subarray(at + 46, at + 46 + nameLen)), method, size, local });
      at += 46 + nameLen + extra + comment;
    }
    return new Zip(bytes, entries);
  }

  names(): string[] {
    return this.entries.map((e) => e.name);
  }

  /** One entry's bytes, inflated up to ENTRY_MAX; undefined when it is missing or can't be read. */
  async bytes(name: string): Promise<Uint8Array | undefined> {
    const entry = this.entries.find((e) => e.name === name);
    if (!entry) return undefined;
    const b = this.archive;
    if (!sig(b, entry.local, LOCAL)) return undefined;
    const nameLen = u16At(b, entry.local + 26);
    const extra = u16At(b, entry.local + 28);
    if (nameLen === undefined || extra === undefined) return undefined;
    const start = entry.local + 30 + nameLen + extra;
    if (start + entry.size > b.length) return undefined;
    const data = b.subarray(start, start + entry.size);
    if (entry.method === 0) return data.subarray(0, ENTRY_MAX);
    if (entry.method === 8) return inflate(data);
    return undefined;
  }

  /** One entry's text, inflated up to ENTRY_MAX; undefined when it is missing or can't be read. */
  async read(name: string): Promise<string | undefined> {
    const out = await this.bytes(name);
    if (out === undefined) return undefined;
    return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(out);
  }
}

/** Raw deflate, stopping at ENTRY_MAX bytes out; undefined for data that isn't deflate. */
async function inflate(data: Uint8Array): Promise<Uint8Array | undefined> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let len = 0;
  try {
    while (len < ENTRY_MAX) {
      const { done, value } = await reader.read();
      if (done) break;
      const piece = value.subarray(0, ENTRY_MAX - len);
      parts.push(piece);
      len += piece.length;
    }
  } catch {
    // flate2's reader fails the whole read on a corrupt stream.
    return undefined;
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
