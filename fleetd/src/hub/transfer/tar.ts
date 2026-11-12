// The export's container: a POSIX ustar archive of plain files, which `tar tf` lists and `tar xf` unpacks. Written
// and read as a stream, an entry at a time: neither side holds more than the chunk in its hands. The reader is
// strict, since the file is a contract and every byte of it is checked: only plain files, each header's checksum,
// zero padding, and nothing but zeros after the end.
import { createHash } from "node:crypto";

export const BLOCK = 512;
/** The largest size ustar's octal field holds; larger ones are written base-256, as GNU tar and pax readers do. */
const OCTAL_MAX = 0o77777777777;
const NAME_MAX = 100;

export class TarError extends Error {}

const pad = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;
const zeros = (n: number) => new Uint8Array(n);
const isZero = (b: Uint8Array) => b.every((x) => x === 0);

function octal(block: Uint8Array, at: number, len: number, value: number): void {
  block.set(Buffer.from(`${value.toString(8).padStart(len - 1, "0")}\0`, "ascii"), at);
}

function checksum(block: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  return sum;
}

/** The 512-byte header of a plain file `path` of `size` bytes. */
export function tarHeader(path: string, size: number): Uint8Array {
  const name = Buffer.from(path, "utf8");
  if (name.length === 0 || name.length > NAME_MAX) throw new TarError(`an entry's path is 1 to ${NAME_MAX} bytes: ${path}`);
  if (!Number.isSafeInteger(size) || size < 0) throw new TarError(`an entry's size is a whole number of bytes: ${size}`);
  const block = zeros(BLOCK);
  block.set(name, 0);
  octal(block, 100, 8, 0o600);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  if (size <= OCTAL_MAX) octal(block, 124, 12, size);
  else {
    block[124] = 0x80;
    let rest = size;
    for (let i = 135; i > 124; i--) {
      block[i] = rest % 256;
      rest = Math.floor(rest / 256);
    }
  }
  octal(block, 136, 12, 0);
  block[156] = 0x30;
  block.set(Buffer.from("ustar\0" + "00", "ascii"), 257);
  block.set(Buffer.from(`${checksum(block).toString(8).padStart(6, "0")}\0 `, "ascii"), 148);
  return block;
}

/** What a header block names; undefined for the all-zero block that ends an archive. */
export function readTarHeader(block: Uint8Array): { path: string; size: number } | undefined {
  if (isZero(block)) return undefined;
  const text = (at: number, len: number) => {
    const field = block.subarray(at, at + len);
    const end = field.indexOf(0);
    return Buffer.from(end < 0 ? field : field.subarray(0, end)).toString("utf8");
  };
  const sum = Number.parseInt(text(148, 8).trim(), 8);
  if (text(257, 5) !== "ustar" || sum !== checksum(block)) throw new TarError("a header's checksum doesn't match");
  if (block[156] !== 0x30 && block[156] !== 0) throw new TarError("an entry isn't a plain file");
  if (text(345, 155) !== "") throw new TarError("an entry's path is split");
  let size: number;
  if (block[124]! & 0x80) {
    size = 0;
    for (let i = 125; i < 136; i++) size = size * 256 + block[i]!;
  } else size = Number.parseInt(text(124, 12).trim(), 8);
  const path = text(0, NAME_MAX);
  if (!Number.isSafeInteger(size) || size < 0 || path === "") throw new TarError("a header doesn't read");
  return { path, size };
}

export type Written = { bytes: number; sha256: string };
type Body = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

/** Writes entries to `write`, one after another; `end` closes the archive. */
export class TarWriter {
  constructor(private readonly write: (chunk: Uint8Array) => void | Promise<void>) {}

  /**
   * One file of exactly `size` bytes, hashed as it goes by. Throws when `body` is shorter; a longer one is cut at
   * `size`, so a file that grows while it is read is carried as it was when it was sized.
   */
  async entry(path: string, size: number, body: Body): Promise<Written> {
    await this.write(tarHeader(path, size));
    const hash = createHash("sha256");
    let left = size;
    const chunks = body instanceof Uint8Array ? [body] : body;
    for await (const chunk of chunks) {
      if (left === 0) break;
      const part = chunk.length > left ? chunk.subarray(0, left) : chunk;
      hash.update(part);
      await this.write(part);
      left -= part.length;
    }
    if (left > 0) throw new TarError(`${path} ended ${left} bytes short`);
    if (pad(size) > 0) await this.write(zeros(pad(size)));
    return { bytes: size, sha256: hash.digest("hex") };
  }

  async end(): Promise<void> {
    await this.write(zeros(2 * BLOCK));
  }
}

/** Hands out a stream's bytes in the sizes asked for. */
class Feed {
  private readonly it: AsyncIterator<Uint8Array>;
  private held: Uint8Array = zeros(0);
  private done = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.it = source[Symbol.asyncIterator]();
  }

  /** Up to `max` bytes, as they come; empty at the stream's end. */
  async some(max: number): Promise<Uint8Array> {
    while (this.held.length === 0 && !this.done) {
      const next = await this.it.next();
      if (next.done) this.done = true;
      else this.held = next.value;
    }
    const out = this.held.subarray(0, max);
    this.held = this.held.subarray(out.length);
    return out;
  }

  /** Exactly `n` bytes; undefined when the stream ends before them. */
  async exactly(n: number): Promise<Uint8Array | undefined> {
    const first = await this.some(n);
    if (first.length === n) return first;
    const out = new Uint8Array(n);
    out.set(first);
    let at = first.length;
    while (at < n) {
      const more = await this.some(n - at);
      if (more.length === 0) return undefined;
      out.set(more, at);
      at += more.length;
    }
    return out;
  }

  async close(): Promise<void> {
    await this.it.return?.();
  }
}

export type TarEntry = {
  path: string;
  size: number;
  /** The entry's bytes, in chunks. What the caller leaves unread is skipped before the next entry. */
  body(): AsyncGenerator<Uint8Array>;
};

/** The whole of a small entry, refused past `max` bytes. */
export async function bodyBytes(entry: TarEntry, max: number): Promise<Uint8Array> {
  if (entry.size > max) throw new TarError(`${entry.path} is larger than it can be`);
  const out = new Uint8Array(entry.size);
  let at = 0;
  for await (const chunk of entry.body()) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * The archive's entries in order. Throws TarError for anything that isn't a whole, well-formed archive of plain files.
 * A chunk of `source` is read before the next one is asked for and not after, so a source may hand out one buffer
 * again and again; a chunk of an entry's body is good that long too.
 */
export async function* tarEntries(source: AsyncIterable<Uint8Array>): AsyncGenerator<TarEntry> {
  const feed = new Feed(source);
  try {
    for (;;) {
      const block = await feed.exactly(BLOCK);
      if (!block) throw new TarError("the file ends before its end");
      const header = readTarHeader(block);
      if (!header) break;
      let left = header.size;
      const body = async function* () {
        while (left > 0) {
          const chunk = await feed.some(left);
          if (chunk.length === 0) throw new TarError(`the file ends inside ${header.path}`);
          left -= chunk.length;
          yield chunk;
        }
      };
      yield { ...header, body };
      for await (const _ of body()) void _;
      const padding = await feed.exactly(pad(header.size));
      if (!padding || !isZero(padding)) throw new TarError(`the padding after ${header.path} isn't empty`);
    }
    for (let first = true; ; first = false) {
      const rest = await feed.some(64 * 1024);
      if (rest.length === 0) {
        if (first) throw new TarError("the file ends before its end");
        break;
      }
      if (!isZero(rest)) throw new TarError("there is something after the file's end");
    }
  } finally {
    await feed.close();
  }
}
