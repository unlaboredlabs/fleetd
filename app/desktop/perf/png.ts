// One pixel of an 8-bit RGB or RGBA PNG (what Chromium's canvas writes), so the recording smoke can check the
// painted traffic lights without an image library.
import { inflateSync } from "node:zlib";

export const pixel = (png: Uint8Array, x: number, y: number): [number, number, number] => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0;
  let channels = 0;
  const idat: Array<Uint8Array> = [];
  for (let at = 8; at < png.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      const depth = data[8];
      const color = data[9];
      if (depth !== 8 || (color !== 2 && color !== 6) || data[12] !== 0) throw new Error("only 8-bit, non-interlaced RGB(A) PNGs");
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  let previous = new Uint8Array(stride);
  for (let row = 0; row <= y; row++) {
    const filter = raw[row * (stride + 1)] ?? 0;
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const out = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (out[i - channels] ?? 0) : 0;
      const b = previous[i] ?? 0;
      const c = i >= channels ? (previous[i - channels] ?? 0) : 0;
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const predictor = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter] ?? 0;
      out[i] = ((line[i] ?? 0) + predictor) & 255;
    }
    previous = out;
  }
  const at = x * channels;
  return [previous[at] ?? 0, previous[at + 1] ?? 0, previous[at + 2] ?? 0];
};
