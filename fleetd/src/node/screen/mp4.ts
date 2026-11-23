// A screen's own H.264 frames as a fragmented MP4 (`video.mp4`), written as they come, with nothing to encode or to run
// beside the node: the recording is the very stream the live view shows. Each frame is a fragment of its own (moof +
// mdat), timed in ms from the screen's start (its tfdt), so the replay's clock is the action log's. The sample entry is
// `avc3`: the parameter sets travel in the stream before each keyframe, so a picture that changes size mid-way (a
// simulator turned, an iPhone Duo folded) is one track, and any fragment from a keyframe on decodes alone. A frame is
// written once the next comes (its duration is the gap to it); `end` writes the last. A file cut short (the node
// stopped) plays up to its last whole fragment, and the next node goes on writing into it (`resumeAt`).
import { closeSync, openSync, readSync, fstatSync } from "node:fs";

/** One frame: an access unit in Annex B (parameter sets first on a keyframe), when it was made (ms from the screen's
 * start), and the picture's size. */
export type Mp4Frame = { data: Uint8Array; key: boolean; atMs: number; size: [number, number] };

/** ms: the file's timescale. */
export const TIMESCALE = 1000;

const enc = new TextEncoder();

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, size);
  out.set(enc.encode(type), 4);
  let at = 8;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A full box: version and flags first. */
const full = (type: string, version: number, flags: number, ...parts: Uint8Array[]) => box(type, u8(version), u24(flags), ...parts);

const u8 = (n: number) => Uint8Array.of(n & 0xff);
const u16 = (n: number) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
const u24 = (n: number) => Uint8Array.of((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0);
  return out;
}
function u64(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.max(0, Math.round(n))));
  return out;
}
const zeros = (n: number) => new Uint8Array(n);
/** The identity matrix of mvhd and tkhd. */
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32);

/** The NAL units of an Annex B access unit, without their start codes. */
export function nalUnits(annexB: Uint8Array): Uint8Array[] {
  const starts: [number, number][] = [];
  for (let i = 0; i + 2 < annexB.length; i++) {
    if (annexB[i] !== 0 || annexB[i + 1] !== 0) continue;
    if (annexB[i + 2] === 1) {
      starts.push([i, i + 3]);
      i += 2;
    } else if (annexB[i + 2] === 0 && annexB[i + 3] === 1) {
      starts.push([i, i + 4]);
      i += 3;
    }
  }
  return starts.map(([, from], k) => annexB.subarray(from, k + 1 < starts.length ? starts[k + 1]![0] : annexB.length)).filter((n) => n.length > 0);
}

/** An access unit as MP4 keeps it: each NAL unit after its 4-byte length. */
export function lengthPrefixed(annexB: Uint8Array): Uint8Array {
  const units = nalUnits(annexB);
  const out = new Uint8Array(units.reduce((n, u) => n + 4 + u.length, 0));
  const v = new DataView(out.buffer);
  let at = 0;
  for (const u of units) {
    v.setUint32(at, u.length);
    out.set(u, at + 4);
    at += 4 + u.length;
  }
  return out;
}

/** ftyp and moov for one H.264 track of `size`, its profile and level from the stream's SPS (`sps`, its first byte
 * the NAL header). */
export function initSegment(size: [number, number], sps: Uint8Array): Uint8Array {
  const [w, h] = size;
  const profile = sps[1] ?? 66;
  // avcC with no parameter sets of its own (avc3: they are in the stream); High profiles carry the chroma fields too.
  const high = [100, 110, 122, 144].includes(profile);
  const avcC = box("avcC", Uint8Array.of(1, profile, sps[2] ?? 0, sps[3] ?? 30, 0xff, 0xe0, 0), ...(high ? [Uint8Array.of(0xfd, 0xf8, 0xf8, 0)] : []));
  const avc3 = box(
    "avc3",
    zeros(6),
    u16(1),
    zeros(16),
    u16(w),
    u16(h),
    u32(0x00480000),
    u32(0x00480000),
    zeros(4),
    u16(1),
    zeros(32),
    u16(0x18),
    u16(0xffff),
    avcC,
  );
  const stbl = box(
    "stbl",
    full("stsd", 0, 0, u32(1), avc3),
    full("stts", 0, 0, u32(0)),
    full("stsc", 0, 0, u32(0)),
    full("stsz", 0, 0, u32(0), u32(0)),
    full("stco", 0, 0, u32(0)),
  );
  const minf = box("minf", full("vmhd", 0, 1, zeros(8)), box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))), stbl);
  const mdia = box(
    "mdia",
    full("mdhd", 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(0), u16(0x55c4), u16(0)),
    full("hdlr", 0, 0, u32(0), enc.encode("vide"), zeros(12), enc.encode("fleetd screen\0")),
    minf,
  );
  const tkhd = full("tkhd", 0, 3, u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8), u16(0), u16(0), u16(0), u16(0), ...MATRIX, u32(w << 16), u32(h << 16));
  const mvhd = full("mvhd", 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(0), u32(0x00010000), u16(0x0100), zeros(10), ...MATRIX, zeros(24), u32(2));
  const mvex = box("mvex", full("trex", 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)));
  const ftyp = box("ftyp", enc.encode("iso6"), u32(0), enc.encode("iso6"), enc.encode("iso5"), enc.encode("mp41"));
  return concat([ftyp, box("moov", mvhd, box("trak", tkhd, mdia), mvex)]);
}

/** One frame's fragment: moof (its sequence number, start, duration, size and whether it is a keyframe) and mdat. */
export function fragment(sequence: number, startMs: number, durationMs: number, key: boolean, sample: Uint8Array): Uint8Array {
  // sample_depends_on 2 (a keyframe depends on none), else 1 and sample_is_non_sync_sample.
  const flags = key ? 0x02000000 : 0x01010000;
  const trun = (offset: number) => full("trun", 0, 0x000701, u32(1), u32(offset), u32(Math.max(1, Math.round(durationMs))), u32(sample.length), u32(flags));
  const traf = (offset: number) => box("traf", full("tfhd", 0, 0x020000, u32(1)), full("tfdt", 1, 0, u64(startMs)), trun(offset));
  const moofOf = (offset: number) => box("moof", full("mfhd", 0, 0, u32(sequence)), traf(offset));
  const size = moofOf(0).length;
  return concat([moofOf(size + 8), box("mdat", sample)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Where a file this writer made ends: whether it has its init segment, and its last fragment's sequence number and
 * end (ms); undefined for none or no file. Only its whole top-level boxes count: a box cut short is the end. */
export function resumeAt(path: string): { sequence: number; endMs: number; bytes: number } | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = fstatSync(fd).size;
    const head = new Uint8Array(8);
    let at = 0;
    let init = false;
    let sequence = 0;
    let endMs = 0;
    let whole = 0;
    // A fragment counts once its mdat is whole too.
    let fragmentRead: { sequence: number; startMs: number; durationMs: number } | undefined;
    while (at + 8 <= size) {
      readSync(fd, head, 0, 8, at);
      const len = new DataView(head.buffer).getUint32(0);
      const type = new TextDecoder().decode(head.subarray(4, 8));
      if (len < 8 || at + len > size) break;
      if (type === "moov") init = true;
      if (type === "moof") {
        const moof = new Uint8Array(len);
        readSync(fd, moof, 0, len, at);
        fragmentRead = readMoof(moof);
      } else if (type === "mdat" && fragmentRead) {
        sequence = fragmentRead.sequence;
        endMs = fragmentRead.startMs + fragmentRead.durationMs;
        fragmentRead = undefined;
      }
      at += len;
      if (type !== "moof") whole = at;
    }
    return init ? { sequence, endMs, bytes: whole } : undefined;
  } finally {
    closeSync(fd);
  }
}

/** A one-sample moof as `fragment` writes it: its sequence number, start and duration. */
function readMoof(moof: Uint8Array): { sequence: number; startMs: number; durationMs: number } | undefined {
  const v = new DataView(moof.buffer, moof.byteOffset, moof.length);
  // moof(8), mfhd(8 + 4 + 4: the sequence number at 20), traf(8) at 24, tfhd(8 + 4 + 4) at 32, tfdt v1 (8 + 4 + 8: the
  // start at 60) at 48, trun at 68: 8 + 4, its count, its data offset, then the sample's duration at 88.
  if (moof.length < 100) return undefined;
  const sequence = v.getUint32(20);
  const startMs = Number(v.getBigUint64(60));
  const durationMs = v.getUint32(88);
  return { sequence, startMs, durationMs };
}

/**
 * Writes a screen's frames into an MP4 as they come (`write` appends bytes to the file). Frames before the first
 * keyframe are let go: nothing decodes without one. `resume` goes on in a file a writer left (resumeAt): its init
 * segment is there, and the sequence numbers go on from its last.
 */
export class Mp4Writer {
  private pending: Mp4Frame | undefined;
  private sequence: number;
  private started: boolean;

  constructor(
    private readonly write: (bytes: Uint8Array) => void,
    resume?: { sequence: number },
  ) {
    this.sequence = resume?.sequence ?? 0;
    this.started = resume !== undefined;
  }

  /** Whether a frame has gone in: the file plays. */
  has(): boolean {
    return this.sequence > 0;
  }

  frame(frame: Mp4Frame): void {
    if (this.pending === undefined && !frame.key) return;
    if (this.pending) this.flush(Math.max(frame.atMs, this.pending.atMs + 1));
    if (!this.started) {
      const sps = nalUnits(frame.data).find((n) => (n[0]! & 0x1f) === 7);
      if (!sps) return;
      this.write(initSegment(frame.size, sps));
      this.started = true;
    }
    this.pending = frame;
  }

  /** The last frame, shown until `atMs`. */
  end(atMs: number): void {
    if (this.pending) this.flush(Math.max(atMs, this.pending.atMs + 1));
    this.pending = undefined;
  }

  private flush(untilMs: number): void {
    const f = this.pending!;
    this.write(fragment(++this.sequence, f.atMs, untilMs - f.atMs, f.key, lengthPrefixed(f.data)));
  }
}
