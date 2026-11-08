// A watched screen's live frames, fitted to what its slowest watcher's link takes (the hub's `kbps`), for every kind
// of screen alike (crates/fleetd/src/node/browser/fit.rs). Without a budget each frame goes as its kind made it. With
// one, frames aim at AIM of it: each waits until the one before has had its time on the link, and when even MIN_FPS
// frames a second at the kind's own quality wouldn't fit, a frame is encoded again at a lower one first (Bun's
// libjpeg-turbo, off the event loop). Only the live view's copy: the session's video keeps every frame as it was.
import type { BrowserFrame } from "../../shared/contracts.ts";

const AIM = 0.8;
const MIN_FPS = 3;
const MAX_WAIT = 2_000;
const QUALITIES = [0, 40, 25] as const;
const SIZES = [1, 0.64, 0.5] as const;

/** Bytes a ms the frames aim at. */
const rate = (kbps: number) => (Math.max(kbps, 1) * 1000) / 8 / 1000 * AIM;

/** The best tier whose frames fit MIN_FPS a second into `rate`; the lowest when none does. */
function tier(perMs: number, full: number): number {
  for (let t = 0; t < SIZES.length; t++) if (((full * SIZES[t]! * MIN_FPS) / 1000) <= perMs) return t;
  return SIZES.length - 1;
}

const bytesOf = (f: BrowserFrame) => Math.floor(f.jpegB64.length / 4) * 3;

/** The frames that went to one watcher: how big the last was, when, and at which tier. */
export class Pacer {
  private last: { at: number; bytes: number; tier: number } | undefined;

  /** How long the next frame waits for the link, in ms: none without a budget. */
  wait(kbps: number | undefined): number {
    if (kbps === undefined || !this.last) return 0;
    const due = this.last.at + Math.min(this.last.bytes / rate(kbps), MAX_WAIT);
    return Math.max(due - performance.now(), 0);
  }

  /** The frame as it goes to the watcher: itself, or under a tight budget the same screen at a lower quality. */
  async fit(kbps: number | undefined, frame: BrowserFrame): Promise<BrowserFrame> {
    const t = kbps !== undefined && this.last ? tier(rate(kbps), this.last.bytes / SIZES[this.last.tier]!) : 0;
    let out = frame;
    let used = 0;
    if (t > 0) {
      try {
        const jpeg = Buffer.from(frame.jpegB64, "base64");
        const smaller = await new Bun.Image(jpeg).jpeg({ quality: QUALITIES[t]! }).bytes();
        if (smaller.length < jpeg.length) {
          out = { ...frame, jpegB64: Buffer.from(smaller).toString("base64") };
          used = t;
        }
      } catch {
        // A frame that doesn't decode goes as it came.
      }
    }
    this.last = { at: performance.now(), bytes: bytesOf(out), tier: used };
    return out;
  }
}

/** A JPEG's width and height, from its first start-of-frame marker (session.rs `jpeg_size`). */
export function jpegSize(jpeg: Uint8Array): [number, number] | undefined {
  let at = 2;
  while (at + 9 < jpeg.length) {
    if (jpeg[at] !== 0xff) return undefined;
    const marker = jpeg[at + 1]!;
    const len = (jpeg[at + 2]! << 8) | jpeg[at + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (jpeg[at + 5]! << 8) | jpeg[at + 6]!;
      const width = (jpeg[at + 7]! << 8) | jpeg[at + 8]!;
      return width > 0 && height > 0 ? [width, height] : undefined;
    }
    at += 2 + len;
  }
  return undefined;
}
