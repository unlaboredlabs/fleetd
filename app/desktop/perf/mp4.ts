// Just enough of ISO BMFF to check a FLEETD_RECORD output without ffprobe: the top-level layout, the codec in the
// sample description, and the frames in the fragments MediaRecorder writes.

export interface Mp4Summary {
  /** Top-level box types, in file order. */
  readonly boxes: ReadonlyArray<string>;
  /** Sample entry types (avc1, ...). */
  readonly codecs: ReadonlyArray<string>;
  readonly width: number;
  readonly height: number;
  /** Samples over every fragment's track runs (and a plain moov's sample sizes). */
  readonly frames: number;
}

interface Box {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "moof", "traf", "mvex", "edts"]);

const children = (view: DataView, start: number, end: number): Array<Box> => {
  const out: Array<Box> = [];
  for (let at = start; at + 8 <= end; ) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) throw new Error(`box ${type} at ${at} runs past its parent`);
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
};

export const summarize = (bytes: Uint8Array): Mp4Summary => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = children(view, 0, bytes.byteLength);
  const codecs: Array<string> = [];
  let width = 0;
  let height = 0;
  let frames = 0;
  const walk = (boxes: ReadonlyArray<Box>) => {
    for (const box of boxes) {
      if (CONTAINERS.has(box.type)) walk(children(view, box.start, box.end));
      else if (box.type === "stsd") {
        // version/flags (4) and entry count (4), then sample entries; a visual entry has its size at +32.
        for (const entry of children(view, box.start + 8, box.end)) {
          codecs.push(entry.type);
          if (entry.end - entry.start >= 28) {
            width = view.getUint16(entry.start + 24);
            height = view.getUint16(entry.start + 26);
          }
        }
      } else if (box.type === "trun") frames += view.getUint32(box.start + 4);
      else if (box.type === "stsz") frames += view.getUint32(box.start + 8);
    }
  };
  walk(top);
  return { boxes: top.map((b) => b.type), codecs, width, height, frames };
};
