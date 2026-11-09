// The picture's render (crates/fleetd/src/hub/projects/avatar.rs `render`), on avatar-worker.ts's thread: decoding
// and cropping a photo takes a second or more, which the hub's own thread can't spare (Rust runs it in spawn_blocking).
import { deflateSync, inflateSync } from "node:zlib";
import type { AvatarCrop } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";

/** A kept picture's side at most, in pixels (contracts `AVATAR_PX`). */
export const AVATAR_PX = 512;
/** The kept JPEG's most bytes: a busier picture is encoded again at a lower quality until it fits. */
export const AVATAR_MAX_BYTES = 160 * 1024;
/** A picture wider or taller than this is refused before it is decoded. */
const SOURCE_MAX_PX = 12_000;
/** The most pixels decoding one picture may take: Rust's 512 MB allocation limit, at 4 bytes a pixel. */
const SOURCE_MAX_PIXELS = (512 * 1024 * 1024) / 4;
const QUALITIES = [86, 76, 64, 50];

const unusable = (why: string) =>
  new ToolError("invalid", `That picture can't be used: ${why}.`, "Pick a photo or a png, jpeg or webp image.");

/** The square `crop` names, inside a `w` × `h` picture: moved, then shrunk, to fit. Absent: the largest in the middle. */
export function square(w: number, h: number, crop: AvatarCrop | undefined): [number, number, number] {
  const short = Math.min(w, h);
  if (!crop) return [Math.floor((w - short) / 2), Math.floor((h - short) / 2), short];
  const px = (n: number) => (n < 0 ? Number.MAX_SAFE_INTEGER : n);
  const size = Math.min(Math.max(px(crop.size), 1), short);
  return [Math.min(px(crop.x), w - size), Math.min(px(crop.y), h - size), size];
}

/**
 * Walks an 8-bit, non-interlaced PNG's rows, as Bun.Image writes one (grey, grey+alpha, RGB or RGBA), up to the
 * first `onRow` returns false for: only two rows are unfiltered at once.
 */
export function pngRows(png: Uint8Array, onRow: (y: number, row: Uint8Array) => boolean): { width: number; height: number; channels: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colour = 0;
  const idat: Uint8Array[] = [];
  while (at + 8 <= png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      if (data[8] !== 8 || data[12] !== 0) throw unusable("it doesn't decode");
      colour = data[9] ?? 0;
    } else if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colour];
  if (channels === undefined) throw unusable("it doesn't decode");
  const raw = inflateSync(idat.length === 1 ? idat[0]! : Buffer.concat(idat));
  const stride = width * channels;
  let prev: Uint8Array | undefined;
  let row: Uint8Array = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels]! : 0;
      const up = prev ? prev[i]! : 0;
      const c = prev && i >= channels ? prev[i - channels]! : 0;
      let v = line[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      row[i] = v & 0xff;
    }
    if (!onRow(y, row)) break;
    const done = prev ?? new Uint8Array(stride);
    prev = row;
    row = done;
  }
  return { width, height, channels };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** An RGB PNG of `pixels`, for Bun.Image to resize and encode. */
function rgbPng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", new Uint8Array())]);
}

/**
 * The picture as the hub keeps it (avatar.rs `render`): decoded, turned upright, cropped, at most AVATAR_PX a side,
 * on white where it was transparent, and a JPEG of at most AVATAR_MAX_BYTES with no metadata. A crop wider than
 * AVATAR_PX is shrunk with the whole picture first, natively, so a photo's pixels never reach JavaScript at full size.
 */
export async function render(bytes: Uint8Array, crop: AvatarCrop | undefined): Promise<Uint8Array> {
  const open = () => new Bun.Image(bytes, { maxPixels: SOURCE_MAX_PIXELS, autoOrient: true });
  let meta: { width: number; height: number; format: string };
  try {
    meta = await open().metadata();
  } catch (error) {
    throw unusable((error as Error).message || "it doesn't decode");
  }
  if (meta.format !== "png" && meta.format !== "jpeg" && meta.format !== "webp") throw unusable("it isn't a png, jpeg or webp image");
  if (meta.width > SOURCE_MAX_PX || meta.height > SOURCE_MAX_PX) throw unusable(`it is over ${SOURCE_MAX_PX} pixels a side`);
  if (meta.width === 0 || meta.height === 0) throw unusable("it is empty");
  // The crop names the upright picture; turned a quarter, its sides swap, so the shrunk picture's shape says which.
  const long = Math.max(meta.width, meta.height);
  const short = Math.min(meta.width, meta.height);
  const want = square(long, short, crop && { x: 0, y: 0, size: crop.size })[2];
  const shrink = want > AVATAR_PX ? AVATAR_PX / want : 1;
  let png: Uint8Array;
  try {
    const box = Math.max(1, Math.round(long * shrink));
    png = await (shrink < 1 ? open().resize(box, box, { fit: "inside", filter: "lanczos3" }) : open()).png({ compressionLevel: 0 }).bytes();
  } catch (error) {
    throw unusable((error as Error).message || "it doesn't decode");
  }
  const dims = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const [w, h] = [dims.getUint32(16), dims.getUint32(20)];
  if (w === 0 || h === 0) throw unusable("it is empty");
  const [uw, uh] = w >= h === meta.width >= meta.height ? [meta.width, meta.height] : [meta.height, meta.width];
  const [ux, uy, usize] = square(uw, uh, crop);
  const scale = Math.max(w, h) / long;
  const [x, y, size] = scale === 1 ? [ux, uy, usize] : square(w, h, { x: Math.round(ux * scale), y: Math.round(uy * scale), size: Math.round(usize * scale) });
  const side = Math.min(usize, AVATAR_PX);
  // Cropped, and laid on white where it was clear: a JPEG has no transparency.
  const rgb = new Uint8Array(size * size * 3);
  try {
    pngRows(png, (at, line) => {
      if (at < y) return true;
      const channels = line.length / w;
      const grey = channels <= 2;
      for (let col = 0; col < size; col++) {
        const from = (x + col) * channels;
        const to = ((at - y) * size + col) * 3;
        const alpha = channels === 2 ? line[from + 1]! : channels === 4 ? line[from + 3]! : 255;
        for (let k = 0; k < 3; k++) {
          const c = line[from + (grey ? 0 : k)]!;
          rgb[to + k] = Math.floor((c * alpha + 255 * (255 - alpha)) / 255);
        }
      }
      return at + 1 < y + size;
    });
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw unusable((error as Error).message || "it doesn't decode");
  }
  const kept = () => {
    const image = new Bun.Image(rgbPng(size, size, rgb));
    return size !== side ? image.resize(side, side, { fit: "fill", filter: "lanczos3" }) : image;
  };
  for (const quality of QUALITIES) {
    const out = await kept().jpeg({ quality }).bytes();
    if (out.length <= AVATAR_MAX_BYTES) return out;
  }
  throw unusable("it doesn't shrink small enough");
}
