// What a desktop session reads and drives (crates/fleetd/src/node/desktop/screen.rs): a Linux display over the node's
// own X11 connection (x11.ts). The session's live view, takeover and the agent's `desktop` actions sit on this alone.
//
// The JPEG is Bun's own (`Bun.Image`, libjpeg-turbo), from the screen's BGRA wrapped as a top-down 32-bit BMP: no
// native helper. Bun's encoder takes no chroma table, so colour goes 4:2:0 at QUALITY, where the Rust node keeps it
// 4:4:4 at a coarser quality (red or blue text on a dark terminal comes out a little softer here).

/** One read of the screen: its pixels as the screen gives them, at its size then. */
export type Raw = { data: Uint8Array; width: number; height: number };

/** One grab of the screen, as a JPEG. */
export type Shot = { jpeg: Uint8Array; width: number; height: number };

/** JPEG quality of a desktop's frames (the live view's and the agent's screenshots). */
export const QUALITY = 70;

const BMP_HEAD = 14 + 40;

/** A screen's pixels (32 bits each, BGRA in memory) as a BMP Bun.Image reads: top-down, the fourth byte ignored. */
export function bmp(bgra: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(BMP_HEAD + width * height * 4);
  const v = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  v.setUint32(2, out.length, true);
  v.setUint32(10, BMP_HEAD, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, width, true);
  v.setInt32(22, -height, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, 32, true);
  v.setUint32(34, width * height * 4, true);
  out.set(bgra.subarray(0, width * height * 4), BMP_HEAD);
  return out;
}

/** A screen's pixels (32 bits each, BGRA in memory) as a JPEG. */
export async function jpeg(bgra: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  if (width > 0xffff) throw new Error("the screen is too wide to encode");
  if (height > 0xffff) throw new Error("the screen is too tall to encode");
  try {
    return await new Bun.Image(bmp(bgra, width, height)).jpeg({ quality: QUALITY }).bytes();
  } catch (e) {
    throw new Error(`cannot encode the screen: ${(e as Error).message}`);
  }
}

/** A screen: its pixels, and input as a person or an agent gives it. Coordinates are the screen's own pixels, as its
 * frames show them. */
export interface Screen {
  /** Its size now. */
  size(): [number, number];
  /** Whether it may have changed since the last call: always, where the screen can't say. */
  changed(): boolean;
  grabRaw(): Promise<Raw>;
  encode(raw: Raw): Promise<Uint8Array>;
  /** The whole screen, as a JPEG. */
  grab(): Promise<Shot>;
  /** Waits until everything sent so far is done. */
  sync(): Promise<void>;
  moveTo(x: number, y: number): Promise<void>;
  /** Presses or releases a mouse button (1 left, 2 middle, 3 right) where the pointer is. */
  button(button: number, down: boolean): Promise<void>;
  click(x: number, y: number, button: number, count: number): Promise<void>;
  drag(from: [number, number], to: [number, number]): Promise<void>;
  /** Wheel clicks at a point: `dy` > 0 scrolls down, `dx` > 0 right. */
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
  pointer(): Promise<[number, number]>;
  /** Presses or releases one key by its X keysym; Shift goes with it where the keyboard needs it, when `shift`
   * allows. */
  keySym(sym: number, down: boolean, shift: boolean): Promise<void>;
  /** A chord as xdotool names it (`ctrl+shift+t`): every key pressed in order, then released in reverse. */
  chord(chord: string): Promise<void>;
  typeText(text: string): Promise<void>;
  /** Runs `fn` once every use queued before it is done: one use at a time. */
  serial<T>(fn: () => Promise<T>): Promise<T>;
  close(): void;
}

/** What `launch` saw of an app in its first moments: exited already, its code and the end of what it printed. */
export type Launched = { pid: number; exited?: { code: number | null; output: string } };

/** What a session was lent to put its screen on: a display of its own, thrown away by `drop`. */
export interface Lent {
  /** Starts an app on the screen with `sh -c`, in `cwd` where the screen's apps can see it, and looks at it a moment
   * later. */
  launch(command: string, cwd: string): Promise<Launched>;
  /** Throws it away with everything on it. */
  drop(): Promise<void>;
}
