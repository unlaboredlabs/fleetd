// An image's preview (attachment_get's maxSide; crates/fleetd/src/hub/intake/preview.rs): what a chat bubble shows on
// the phone or the desktop, rather than the photo or screenshot itself, which the full-screen viewer reads. A png, jpeg
// or webp larger than the side asked for is decoded, turned upright as its EXIF says, shrunk to fit and encoded as a
// JPEG, or as a PNG where any pixel is clear. One already that small, one whose shrunk copy isn't smaller than the
// file, one that won't decode, and anything else (a GIF, which may move) come as themselves. Bun.Image does the decode,
// resize and encode on a worker thread (libjpeg-turbo, libspng, libwebp), so no Rust helper is needed for it.
import { inflateSync } from "node:zlib";
import type { AttachmentMime, KnownAttachmentMime } from "../../shared/contracts.ts";

/** A picture wider or taller than this isn't decoded for a preview. */
const SOURCE_MAX_PX = 12_000;
/** A preview's JPEG quality: a bubble's photo or screenshot, its text still crisp. */
const QUALITY = 82;

/** Turns at something at most `n` at once; the rest wait in order. */
export class Turns {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(n: number) {
    this.free = n;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}

/**
 * Pictures decoded for previews at once: each may take hundreds of MiB, and a chat's bubbles all ask together, so the
 * rest wait their turn rather than hold gigabytes on a small hub.
 */
export const TURNS = new Turns(2);

/** The picture in `bytes` shrunk to at most `side` pixels a side, and its type; undefined when the file itself is the better answer. */
export async function shrink(
  bytes: Uint8Array,
  mime: AttachmentMime,
  side: number,
): Promise<{ bytes: Uint8Array; mime: KnownAttachmentMime } | undefined> {
  if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp") return undefined;
  const open = () => new Bun.Image(bytes, { maxPixels: SOURCE_MAX_PX * SOURCE_MAX_PX, autoOrient: true });
  try {
    const { width, height, format } = await open().metadata();
    if (format !== mime.slice("image/".length)) return undefined;
    if (width > SOURCE_MAX_PX || height > SOURCE_MAX_PX) return undefined;
    if (width <= side && height <= side) return undefined;
    const small = () => open().resize(side, side, { fit: "inside", filter: "lanczos3" });
    let out: Uint8Array | undefined;
    let as: KnownAttachmentMime = "image/jpeg";
    if (mayBeClear(bytes, mime)) {
      const png = await small().png().bytes();
      if (hasClearPixel(png)) {
        out = png;
        as = "image/png";
      }
    }
    out ??= await small().jpeg({ quality: QUALITY }).bytes();
    return out.length < bytes.length ? { bytes: out, mime: as } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the file can hold a clear pixel at all: a PNG with an alpha channel or tRNS, a WebP with alpha. */
function mayBeClear(b: Uint8Array, mime: AttachmentMime): boolean {
  if (mime === "image/png") {
    const colour = b[25];
    return colour === 4 || colour === 6 || pngChunks(b).some((c) => c.type === "tRNS");
  }
  if (mime === "image/webp") {
    const chunk = String.fromCharCode(...b.subarray(12, 16));
    if (chunk === "VP8X") return (b[20]! & 0x10) !== 0;
    if (chunk === "VP8L") return ((b[24]! >> 4) & 1) !== 0;
  }
  return false;
}

function pngChunks(b: Uint8Array): { type: string; data: Uint8Array }[] {
  const chunks: { type: string; data: Uint8Array }[] = [];
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let at = 8; at + 12 <= b.length; ) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
    if (at + 12 + len > b.length) break;
    chunks.push({ type, data: b.subarray(at + 8, at + 8 + len) });
    if (type === "IEND") break;
    at += 12 + len;
  }
  return chunks;
}

/**
 * Whether any pixel of a PNG (as Bun.Image writes one: not interlaced) is less than opaque. A palette or a tRNS colour
 * key counts as clear without reading pixels; so does a PNG this can't read, since a PNG is then the safe answer.
 */
export function hasClearPixel(png: Uint8Array): boolean {
  const chunks = pngChunks(png);
  const ihdr = chunks.find((c) => c.type === "IHDR")?.data;
  if (!ihdr || ihdr.length < 13) return true;
  const view = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  const depth = ihdr[8];
  const colour = ihdr[9];
  if (chunks.some((c) => c.type === "tRNS")) return true;
  if (colour !== 4 && colour !== 6) return false;
  if (ihdr[12] !== 0 || (depth !== 8 && depth !== 16)) return true;
  const channels = colour === 6 ? 4 : 2;
  const bpp = (channels * depth) / 8;
  const stride = width * bpp;
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
  } catch {
    return true;
  }
  if (raw.length < height * (stride + 1)) return true;
  let prev = new Uint8Array(stride);
  let row = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0;
      const up = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
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
    // Alpha is each pixel's last channel; 16-bit samples are big-endian, both bytes 0xff when opaque.
    const sample = depth / 8;
    for (let px = 0; px < width; px++) {
      const at = px * bpp + (channels - 1) * sample;
      if (row[at] !== 0xff || (sample === 2 && row[at + 1] !== 0xff)) return true;
    }
    [prev, row] = [row, prev];
  }
  return false;
}
