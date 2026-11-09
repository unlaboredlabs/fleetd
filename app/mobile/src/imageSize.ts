// A picture's size read from its own header (PNG, JPEG, GIF, WebP), at once: a bubble is drawn at its shape from its
// first frame, rather than as a stand-in that changes size once the image is decoded (Image.getSize answers a frame or
// more later). Undefined for a header it can't read, which falls back to that.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALUE = new Map([...ALPHABET].map((c, i) => [c.charCodeAt(0), i]));

/** The first `n` bytes of standard base64 `b64` (at most), decoded. */
const head = (b64: string, n: number): Uint8Array => {
  const chars = Math.min(b64.length, Math.ceil(n / 3) * 4);
  const out = new Uint8Array(Math.ceil((chars * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (let i = 0; i < chars; i++) {
    const v = VALUE.get(b64.charCodeAt(i));
    if (v === undefined) continue;
    value = ((value << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 255;
    }
  }
  return out.subarray(0, at);
};

/** How much of a JPEG is looked through for its frame header: most have it in the first few KB, one with an EXIF
 * thumbnail further on. */
const JPEG_HEADS = [8 * 1024, 256 * 1024];

const u16be = (b: Uint8Array, i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number): number => u16le(b, i) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number): number => u16be(b, i) * 65536 + u16be(b, i + 2);

/** The size in pixels of the picture in `b64`, as its file says; undefined when it can't tell. */
export const imageSize = (b64: string): { readonly width: number; readonly height: number } | undefined => {
  const sized = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined);
  const b = head(b64, 32);
  // PNG: its IHDR chunk comes first.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return sized(u32be(b, 16), u32be(b, 20));
  // GIF: the logical screen's size.
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return sized(u16le(b, 6), u16le(b, 8));
  // WebP: a lossy (VP8), lossless (VP8L) or extended (VP8X) chunk.
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const kind = String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0);
    if (kind === "VP8 ") return sized(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
    if (kind === "VP8L") {
      const v = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
      return sized((v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1);
    }
    if (kind === "VP8X") return sized(u24le(b, 24) + 1, u24le(b, 27) + 1);
    return undefined;
  }
  // JPEG: the first start-of-frame marker's size, past the segments before it, turned as its EXIF orientation turns
  // it (iOS draws it turned).
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (const n of JPEG_HEADS) {
      const found = jpegSize(head(b64, n));
      if (found !== "more") return found === undefined ? undefined : sized(found.width, found.height);
      if (b64.length <= (n / 3) * 4) return undefined;
    }
  }
  return undefined;
};

/** A JPEG's size from its first bytes `j`, turned as its EXIF orientation turns it; "more" when `j` stops before it. */
const jpegSize = (j: Uint8Array): { width: number; height: number } | undefined | "more" => {
  let turned = false;
  let i = 2;
  while (i + 9 < j.length) {
    if (j[i] !== 0xff) return undefined;
    const marker = j[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xe1) turned = turnedByExif(j, i + 4) || turned;
    // SOF0-SOF15, but for DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const [width, height] = [u16be(j, i + 7), u16be(j, i + 5)];
      return turned ? { width: height, height: width } : { width, height };
    }
    i += 2 + u16be(j, i + 2);
  }
  return "more";
};

/** Whether the EXIF block at `at` (an APP1 segment's data) turns the picture a quarter: orientations 5 to 8. */
const turnedByExif = (j: Uint8Array, at: number): boolean => {
  if (String.fromCharCode(j[at] ?? 0, j[at + 1] ?? 0, j[at + 2] ?? 0, j[at + 3] ?? 0) !== "Exif") return false;
  const tiff = at + 6;
  const little = j[tiff] === 0x49;
  const u16 = (i: number) => (little ? u16le(j, i) : u16be(j, i));
  const u32 = (i: number) => (little ? u16le(j, i) + u16le(j, i + 2) * 65536 : u32be(j, i));
  const ifd = tiff + u32(tiff + 4);
  const count = u16(ifd);
  for (let n = 0; n < count; n++) {
    const entry = ifd + 2 + n * 12;
    if (entry + 10 > j.length) return false;
    if (u16(entry) === 0x0112) return u16(entry + 8) >= 5 && u16(entry + 8) <= 8;
  }
  return false;
};
