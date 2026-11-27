// A zip read by byte ranges (an XLSX is one): its directory from the file's end, then only the entries a view needs,
// inflated as they stream in (the platform's DecompressionStream), so a sheet's first rows never wait on its last or
// on the workbook's pictures. Stored and deflated entries, as Excel and every spreadsheet app write; no zip64, which a
// file within the workspace's 25 MB never needs.

export interface ZipEntry {
  readonly name: string;
  /** 0 stored, 8 deflated. */
  readonly method: number;
  readonly compressed: number;
  readonly size: number;
  /** Where its local header starts. */
  readonly local: number;
}

export interface Ranged {
  readonly size: number;
  range(offset: number, length: number): Promise<Uint8Array>;
}

export class ZipError extends Error {}

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The end record, and the longest comment after it. */
const TAIL = 22 + 0xffff;

const u16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, at: number) => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;

export async function zipEntries(file: Ranged): Promise<readonly ZipEntry[]> {
  const from = Math.max(0, file.size - TAIL);
  const tail = await file.range(from, file.size - from);
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (u32(tail, at) === END) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ZipError("This isn't a spreadsheet fleetd can read.");
  const count = u16(tail, end + 10);
  const length = u32(tail, end + 12);
  const offset = u32(tail, end + 16);
  // The directory is usually inside the tail already read.
  const dir = offset >= from && offset + length <= file.size ? tail.subarray(offset - from, offset - from + length) : await file.range(offset, length);
  const names = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let at = 0, n = 0; n < count && at + 46 <= dir.length; n++) {
    if (u32(dir, at) !== CENTRAL) throw new ZipError("This spreadsheet's contents are damaged.");
    const nameLength = u16(dir, at + 28);
    out.push({
      method: u16(dir, at + 10),
      compressed: u32(dir, at + 20),
      size: u32(dir, at + 24),
      local: u32(dir, at + 42),
      name: names.decode(dir.subarray(at + 46, at + 46 + nameLength)),
    });
    at += 46 + nameLength + u16(dir, at + 30) + u16(dir, at + 32);
  }
  return out;
}

/** How much of an entry's compressed bytes one read asks for: a sheet's first rows come from its first read. */
const STEP = 256 * 1024;

/** The entry's bytes as they inflate, read from the file a step at a time as they are taken. */
export function entryStream(file: Ranged, entry: ZipEntry): ReadableStream<Uint8Array> {
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError("This spreadsheet is packed in a way fleetd can't read.");
  let at = -1;
  let end = 0;
  const raw = new ReadableStream<Uint8Array>({
    pull: async (c) => {
      if (at < 0) {
        const head = await file.range(entry.local, 30);
        if (u32(head, 0) !== LOCAL) throw new ZipError("This spreadsheet's contents are damaged.");
        at = entry.local + 30 + u16(head, 26) + u16(head, 28);
        end = at + entry.compressed;
      }
      if (at >= end) {
        c.close();
        return;
      }
      const chunk = await file.range(at, Math.min(STEP, end - at));
      if (chunk.length === 0) {
        c.close();
        return;
      }
      at += chunk.length;
      // A copy: the source may hand out a view of bytes it keeps.
      c.enqueue(chunk.slice());
    },
  });
  return entry.method === 0 ? raw : raw.pipeThrough(new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
}

/**
 * The entry as text, read through `take`, which hears each decoded part and says whether to go on: false stops the
 * read (and the reads of the file behind it) there.
 */
export async function readEntryText(file: Ranged, entry: ZipEntry, take: (text: string) => boolean): Promise<void> {
  const reader = entryStream(file, entry).getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        const rest = decoder.decode();
        if (rest !== "") take(rest);
        return;
      }
      if (!take(decoder.decode(value, { stream: true }))) return;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/** The whole entry as text, at most `cap` characters. */
export async function entryText(file: Ranged, entry: ZipEntry, cap = Number.POSITIVE_INFINITY): Promise<string> {
  let text = "";
  await readEntryText(file, entry, (part) => {
    text += part;
    return text.length < cap;
  });
  return text;
}
