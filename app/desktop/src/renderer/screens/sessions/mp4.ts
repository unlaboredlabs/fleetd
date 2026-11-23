// A recording's MP4, read into its H.264 samples for the player (player.ts) to decode with WebCodecs: the node's own
// (fragmented, a fragment a frame, `avc3` with the parameter sets in the stream: fleetd/src/node/screen/mp4.ts), an
// Android emulator's or a Linux desktop's (fragmented by ffmpeg, `avc1`), and an older iOS simulator's (simctl's,
// progressive, with B-frames). Times are ms on the file's own clock: the node's start at the screen's start, so a
// replay's time is the action log's.

/** One sample, in decode order: its decode and presentation times (ms), whether it is a keyframe, and where its bytes
 * are in the file. */
export type Sample = { dts: number; pts: number; key: boolean; offset: number; size: number };

/** A video track: how to configure the decoder (`description`, avcC, for `avc1`: samples length-prefixed; none for
 * `avc3`: samples go as Annex B), its first size, its samples in decode order, and its end (ms). */
export type Track = { codec: string; description?: Uint8Array; width: number; height: number; samples: Sample[]; endMs: number };

type Box = { type: string; start: number; body: number; end: number };

/** A byte of `b` (0 past its end). */
const byte = (b: Uint8Array, at: number) => b[at] ?? 0;
const text = (b: Uint8Array, at: number) => String.fromCharCode(byte(b, at), byte(b, at + 1), byte(b, at + 2), byte(b, at + 3));

function* children(b: Uint8Array, from: number, to: number): Generator<Box> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let at = from; at + 8 <= to; ) {
    let size = v.getUint32(at);
    let body = at + 8;
    if (size === 1) {
      size = Number(v.getBigUint64(at + 8));
      body = at + 16;
    } else if (size === 0) size = to - at;
    // A box cut short (a recording that stopped mid-write) ends the file there.
    if (size < 8 || at + size > to) return;
    yield { type: text(b, at + 4), start: at, body, end: at + size };
    at += size;
  }
}

const child = (b: Uint8Array, box: Box, type: string) => {
  for (const c of children(b, box.body, box.end)) if (c.type === type) return c;
  return undefined;
};
const path = (b: Uint8Array, box: Box | undefined, ...types: string[]) => types.reduce<Box | undefined>((at, t) => (at ? child(b, at, t) : undefined), box);

/** The avc1/avc3 sample entry of an `stsd`: its codec string and size, and avcC (for avc1). */
function sampleEntry(b: Uint8Array, stsd: Box): { codec: string; description?: Uint8Array; width: number; height: number } | undefined {
  // Version and flags, then the entry count.
  for (const entry of children(b, stsd.body + 8, stsd.end)) {
    if (entry.type !== "avc1" && entry.type !== "avc3") continue;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const width = v.getUint16(entry.body + 24);
    const height = v.getUint16(entry.body + 26);
    // The visual sample entry is 78 bytes, then its boxes.
    let avcC: Box | undefined;
    for (const c of children(b, entry.body + 78, entry.end)) if (c.type === "avcC") avcC = c;
    if (!avcC) return undefined;
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    const codec = `${entry.type}.${hex(byte(b, avcC.body + 1))}${hex(byte(b, avcC.body + 2))}${hex(byte(b, avcC.body + 3))}`;
    return { codec, width, height, ...(entry.type === "avc1" ? { description: b.slice(avcC.body, avcC.end) } : {}) };
  }
  return undefined;
}

/** sample_depends_on 2, or not sample_is_non_sync_sample: a keyframe. */
const keyOf = (flags: number) => ((flags >> 24) & 0x3) === 2 || !((flags >> 16) & 0x1);

/** Reads `file`'s first H.264 track; undefined when it has none this player decodes. */
export function readMp4(file: Uint8Array): Track | undefined {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const top = [...children(file, 0, file.length)];
  const moov = top.find((x) => x.type === "moov");
  if (!moov) return undefined;
  let track: { id: number; timescale: number; entry: NonNullable<ReturnType<typeof sampleEntry>>; trak: Box } | undefined;
  for (const trak of children(file, moov.body, moov.end)) {
    if (trak.type !== "trak") continue;
    const stsd = path(file, trak, "mdia", "minf", "stbl", "stsd");
    const mdhd = path(file, trak, "mdia", "mdhd");
    const tkhd = child(file, trak, "tkhd");
    const entry = stsd && sampleEntry(file, stsd);
    if (!entry || !mdhd || !tkhd) continue;
    const timescale = file[mdhd.body] === 1 ? v.getUint32(mdhd.body + 20) : v.getUint32(mdhd.body + 12);
    const id = file[tkhd.body] === 1 ? v.getUint32(tkhd.body + 20) : v.getUint32(tkhd.body + 12);
    track = { id, timescale, entry, trak };
    break;
  }
  if (!track) return undefined;
  const ms = (t: number) => (t * 1000) / track.timescale;
  const samples: Sample[] = [];
  const mvex = child(file, moov, "mvex");
  if (mvex) {
    // Fragmented: each moof's track fragment, with trex's defaults.
    let defaults = { duration: 0, size: 0, flags: 0 };
    for (const trex of children(file, mvex.body, mvex.end)) {
      if (trex.type === "trex" && v.getUint32(trex.body + 4) === track.id) {
        defaults = { duration: v.getUint32(trex.body + 12), size: v.getUint32(trex.body + 16), flags: v.getUint32(trex.body + 20) };
      }
    }
    let next = 0;
    for (const moof of top) {
      if (moof.type !== "moof") continue;
      for (const traf of children(file, moof.body, moof.end)) {
        if (traf.type !== "traf") continue;
        const tfhd = child(file, traf, "tfhd");
        if (!tfhd || v.getUint32(tfhd.body + 4) !== track.id) continue;
        const tf = v.getUint32(tfhd.body) & 0xffffff;
        let at = tfhd.body + 8;
        let base = moof.start;
        if (tf & 0x1) {
          base = Number(v.getBigUint64(at));
          at += 8;
        }
        if (tf & 0x2) at += 4;
        const duration = tf & 0x8 ? v.getUint32((at += 4) - 4) : defaults.duration;
        const size = tf & 0x10 ? v.getUint32((at += 4) - 4) : defaults.size;
        const flags = tf & 0x20 ? v.getUint32(at) : defaults.flags;
        const tfdt = child(file, traf, "tfdt");
        let dts = tfdt ? (file[tfdt.body] === 1 ? Number(v.getBigUint64(tfdt.body + 4)) : v.getUint32(tfdt.body + 4)) : next;
        let dataAt = base;
        for (const trun of children(file, traf.body, traf.end)) {
          if (trun.type !== "trun") continue;
          const rf = v.getUint32(trun.body) & 0xffffff;
          const count = v.getUint32(trun.body + 4);
          let p = trun.body + 8;
          if (rf & 0x1) {
            dataAt = base + v.getInt32(p);
            p += 4;
          }
          let first: number | undefined;
          if (rf & 0x4) {
            first = v.getUint32(p);
            p += 4;
          }
          for (let i = 0; i < count; i++) {
            const d = rf & 0x100 ? v.getUint32((p += 4) - 4) : duration;
            const s = rf & 0x200 ? v.getUint32((p += 4) - 4) : size;
            const f = rf & 0x400 ? v.getUint32((p += 4) - 4) : i === 0 && first !== undefined ? first : flags;
            const cto = rf & 0x800 ? v.getInt32((p += 4) - 4) : 0;
            // A sample past the file's end (cut short) is no sample.
            if (dataAt + s > file.length) break;
            samples.push({ dts: ms(dts), pts: ms(dts + cto), key: keyOf(f), offset: dataAt, size: s });
            dataAt += s;
            dts += d;
          }
        }
        next = dts;
      }
    }
  } else {
    // Progressive: the sample table.
    const stbl = path(file, track.trak, "mdia", "minf", "stbl");
    const box = (t: string) => (stbl ? child(file, stbl, t) : undefined);
    const stsz = box("stsz");
    const stsc = box("stsc");
    const stts = box("stts");
    const chunks = box("stco") ?? box("co64");
    if (!stsz || !stsc || !stts || !chunks) return undefined;
    const fixed = v.getUint32(stsz.body + 4);
    const count = v.getUint32(stsz.body + 8);
    const sizes = Array.from({ length: count }, (_, i) => (fixed !== 0 ? fixed : v.getUint32(stsz.body + 12 + i * 4)));
    const co64 = chunks.type === "co64";
    const offsets = Array.from({ length: v.getUint32(chunks.body + 4) }, (_, i) => (co64 ? Number(v.getBigUint64(chunks.body + 8 + i * 8)) : v.getUint32(chunks.body + 8 + i * 4)));
    const runs = Array.from({ length: v.getUint32(stsc.body + 4) }, (_, i) => ({ first: v.getUint32(stsc.body + 8 + i * 12) - 1, per: v.getUint32(stsc.body + 12 + i * 12) }));
    const times: number[] = [];
    let t = 0;
    for (let i = 0, n = v.getUint32(stts.body + 4); i < n; i++) {
      const c = v.getUint32(stts.body + 8 + i * 8);
      const d = v.getUint32(stts.body + 12 + i * 8);
      for (let k = 0; k < c; k++, t += d) times.push(t);
    }
    const ctts = box("ctts");
    const offsetsCt: number[] = [];
    if (ctts) {
      for (let i = 0, n = v.getUint32(ctts.body + 4); i < n; i++) {
        const c = v.getUint32(ctts.body + 8 + i * 8);
        // Signed whatever the version says: writers put negative offsets in version 0 too (simctl's does).
        const o = v.getInt32(ctts.body + 12 + i * 8);
        for (let k = 0; k < c; k++) offsetsCt.push(o);
      }
    }
    const stss = box("stss");
    const keys = stss ? new Set(Array.from({ length: v.getUint32(stss.body + 4) }, (_, i) => v.getUint32(stss.body + 8 + i * 4) - 1)) : undefined;
    let s = 0;
    for (let c = 0; c < offsets.length && s < count; c++) {
      const run = runs.findLast((r) => r.first <= c);
      let at = offsets[c] ?? 0;
      for (let k = 0; k < (run?.per ?? 0) && s < count; k++, s++) {
        const size = sizes[s] ?? 0;
        if (at + size > file.length) break;
        samples.push({ dts: ms(times[s] ?? t), pts: ms((times[s] ?? t) + (offsetsCt[s] ?? 0)), key: keys ? keys.has(s) : true, offset: at, size });
        at += size;
      }
    }
    // Presentation starts at 0: a file whose first frame shows late (B-frames' delay) is moved back by it.
    const first = Math.min(...samples.map((x) => x.pts));
    if (Number.isFinite(first) && first > 0) for (const x of samples) x.pts -= first;
  }
  const last = samples.reduce((m, x) => Math.max(m, x.pts), 0);
  const first = samples[0];
  const lastOne = samples.at(-1);
  const frameMs = first !== undefined && lastOne !== undefined && samples.length > 1 ? (lastOne.dts - first.dts) / (samples.length - 1) : 0;
  return { ...track.entry, samples, endMs: last + frameMs };
}

/** A sample's bytes as the decoder takes them: as stored for avc1 (length-prefixed, its avcC the description), Annex B
 * for avc3 (its parameter sets in the stream). */
export function chunkData(file: Uint8Array, track: Track, sample: Sample): Uint8Array {
  const data = file.subarray(sample.offset, sample.offset + sample.size);
  if (track.description !== undefined) return data;
  const out = new Uint8Array(data.length);
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = 0; at + 4 <= data.length; ) {
    const n = v.getUint32(at);
    out.set([0, 0, 0, 1], at);
    out.set(data.subarray(at + 4, at + 4 + n), at + 4);
    at += 4 + n;
  }
  return out;
}

/** The sample shown at `t` (the last, in presentation order, at or before it; the first before any), and the
 * keyframe its decode starts from: indexes into `samples`, and the shown one's time. */
export function shownAt(samples: readonly Sample[], t: number): { shown: number; from: number; pts: number } | undefined {
  let shown: { i: number; pts: number } | undefined;
  let earliest: { i: number; pts: number } | undefined;
  samples.forEach((x, i) => {
    if (x.pts <= t && (shown === undefined || x.pts >= shown.pts)) shown = { i, pts: x.pts };
    if (earliest === undefined || x.pts < earliest.pts) earliest = { i, pts: x.pts };
  });
  const pick = shown ?? earliest;
  if (pick === undefined) return undefined;
  let from = pick.i;
  while (from > 0 && samples[from]?.key !== true) from--;
  return { shown: pick.i, from, pts: pick.pts };
}
