// A screen's picture as an H.264 encoder takes it: NV12 (a byte of luma a pixel, then a byte each of Cb and Cr for
// each 2x2), BT.601 limited range as ffmpeg's own conversion makes it. It is kept between grabs and only the part that
// changed is converted again: a terminal scrolling converts its own box (~0.3 ms), not the screen (~2.3 ms, and 4.5 ms
// in ffmpeg), and the encoder reads 1.5 MB a 1280×800 frame, not 4 MB of BGRA. Pure: the sessions import it.

/** A part of a screen: x0, y0 to x1, y1 (not included). */
type Box = [number, number, number, number];

export class Nv12 {
  /** Its size: the screen's, cut to even (4:2:0 needs it). */
  width = 0;
  height = 0;
  data: Uint8Array = new Uint8Array(0);

  /** The picture no longer follows the screen (a grab went by without it): the next update converts it all. */
  forget(): void {
    this.width = 0;
    this.height = 0;
  }

  /**
   * A screen's BGRA pixels (`width` × `height`) into the picture, `box` only (where only it changed) unless the size
   * changed: the picture, good until the next update.
   */
  update(bgra: Uint8Array, width: number, height: number, box?: Box): Uint8Array {
    const w = width & ~1;
    const h = height & ~1;
    if (w !== this.width || h !== this.height) {
      this.width = w;
      this.height = h;
      this.data = new Uint8Array((w * h * 3) / 2);
      box = undefined;
    }
    const [x0, y0, x1, y1] = box ?? [0, 0, w, h];
    // Out to even, so each 2x2 of chroma is whole.
    convert(bgra, width * 4, this.data, w, h, x0 & ~1, y0 & ~1, Math.min(w, (x1 + 1) & ~1), Math.min(h, (y1 + 1) & ~1));
    return this.data;
  }
}

/** The BGRA pixels of a box (even corners) into an NV12 picture `w` × `h`. */
function convert(src: Uint8Array, stride: number, out: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): void {
  const uv = w * h;
  for (let y = y0; y < y1; y += 2) {
    let s0 = y * stride + x0 * 4;
    let s1 = s0 + stride;
    let d0 = y * w + x0;
    let d1 = d0 + w;
    let c = uv + (y >> 1) * w + x0;
    for (let x = x0; x < x1; x += 2) {
      const b0 = src[s0]!, g0 = src[s0 + 1]!, r0 = src[s0 + 2]!;
      const b1 = src[s0 + 4]!, g1 = src[s0 + 5]!, r1 = src[s0 + 6]!;
      const b2 = src[s1]!, g2 = src[s1 + 1]!, r2 = src[s1 + 2]!;
      const b3 = src[s1 + 4]!, g3 = src[s1 + 5]!, r3 = src[s1 + 6]!;
      out[d0] = (66 * r0 + 129 * g0 + 25 * b0 + 4224) >> 8;
      out[d0 + 1] = (66 * r1 + 129 * g1 + 25 * b1 + 4224) >> 8;
      out[d1] = (66 * r2 + 129 * g2 + 25 * b2 + 4224) >> 8;
      out[d1 + 1] = (66 * r3 + 129 * g3 + 25 * b3 + 4224) >> 8;
      // The 2x2's sums: the averages' formulas, times 4.
      const r = r0 + r1 + r2 + r3;
      const g = g0 + g1 + g2 + g3;
      const b = b0 + b1 + b2 + b3;
      out[c] = (-38 * r - 74 * g + 112 * b + 131_584) >> 10;
      out[c + 1] = (112 * r - 94 * g - 18 * b + 131_584) >> 10;
      s0 += 8;
      s1 += 8;
      d0 += 2;
      d1 += 2;
      c += 2;
    }
  }
}
