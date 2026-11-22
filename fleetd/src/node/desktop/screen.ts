// What a desktop session reads and drives: a Linux display over the node's
// own X11 connection (x11.ts). The session's live view, takeover and the agent's `desktop` actions sit on this alone.
//
// The JPEG is Bun's own (`Bun.Image`, libjpeg-turbo), from the screen's BGRA wrapped as a top-down 32-bit BMP: no
// native helper. Bun's encoder takes no chroma table, so colour goes 4:2:0 at QUALITY, where the Rust node keeps it
// 4:4:4 at a coarser quality (red or blue text on a dark terminal comes out a little softer here).
import type { BrowserControl } from "../../shared/contracts.ts";
import type { BrowserRtcFrame, BrowserRtcReport } from "../../shared/screens_wire.ts";
import type { StreamFrame, StreamRun } from "../screen/live.ts";

/** The screen every session gets, in pixels. */
export const SIZE: [number, number] = [1280, 800];

/** What an agent-desktop command names: an app, or a snapshot's refs (mac/agent_desktop.ts). */
export type Target = { app?: string; snapshot?: string };

/** An app on the Mac's screen: every name it goes by, and the one it was asked for (mac/index.ts). */
export type App = { keys: string[]; name: string };

/** A part of a screen: x0, y0 to x1, y1 (not included), in its pixels. */
export type Box = [number, number, number, number];

/** One read of the screen: its pixels as the screen gives them, at its size then. `changed`, where the screen knows it:
 * the part that differs from the read before (null: nothing does). */
export type Raw = { data: Uint8Array; width: number; height: number; changed?: Box | null };

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
  /** Its raw pixels are BGRA in memory, as x264 takes them (an X display's, on a little-endian server). */
  readonly bgra?: boolean;
  /** Whether it may have changed since the last grab: always, where the screen can't say. */
  changed(): boolean;
  /** Resolves once it changes, or after `ms`; absent where the screen can't say (it is read on a timer). */
  nextChange?(ms: number): Promise<void>;
  /** Its pixels now; `whole` reads every one again, where a screen reads only what changed. They may be the screen's
   * own kept copy, good until the next grab: what keeps them longer copies them. */
  grabRaw(whole?: boolean): Promise<Raw>;
  /** The screen as a stream for the live view, a frame as it changes (JPEG or H.264); absent where there is none (an X
   * display's frames come from grabs). */
  stream?(onFrame: (frame: StreamFrame) => void): Promise<StreamRun>;
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

/** What a display that reads itself where it runs sends a session (a box's, ./box_frames.ts): a frame for the
 * watchers, as the hub takes it but for whose session it is, its seq and who drives; or one for the video, JPEG or
 * H.264 (an access unit, Annex B). */
export type LiveFrame = { seq?: number; width: number; height: number; jpegB64?: string; h264B64?: string; key?: boolean };
export type VideoFrame = { kind: "jpeg"; data: Uint8Array } | { kind: "h264"; key: boolean; size: [number, number]; data: Uint8Array };

/** What the watchers asked for, as a session tells its picture (undefined: nobody watches). */
export type Watching = { kbps: number | undefined; video?: boolean; fps?: number; relay?: boolean } | undefined;

/** A screen peer's answer or end, as a picture that answers offers itself reports it (../rtc: `browser_rtc`). */
export type PeerReport = Omit<BrowserRtcReport, "sessionId">;

/** A display's picture, read and encoded where the display runs while the session lives: `ended` says why it stopped
 * by itself. */
export type PictureRun = {
  watch(watching: Watching): void;
  /** The screen now to the watchers, then (with H.264) a keyframe. */
  key(): void;
  /** Who drives now: the watchers' next frame says so. */
  control(control: BrowserControl): void;
  /** An app's screen peer (`browser_rtc`): its offer, answered where the picture is made, or its close. */
  rtc(frame: Omit<BrowserRtcFrame, "sessionId">): void;
  /** The video takes JPEG from now on (it started as JPEG). */
  videoJpeg(): void;
  /** The whole screen, as a JPEG (an agent's screenshot). */
  shot(): Promise<Shot>;
  stop(): void;
  ended: Promise<string | undefined>;
};

/** Where a picture's frames go: the watchers', the video's, and its peers' reports. */
export type PictureSink = { live(frame: LiveFrame): void; video(frame: VideoFrame): void; rtc(report: PeerReport): void };

/** What the session's video takes from a picture: H.264 where it can, JPEG, or nothing (it keeps none). */
export type VideoKind = "h264" | "jpeg" | "none";

/** What a session was lent to put its screen on: a display of its own, thrown away by `drop`, or the Mac's lease. */
export interface Lent {
  /** It runs in the agent's own box (../place/box_screens.ts), so what it launches runs beside the agent's files. */
  readonly inBox?: boolean;
  /** Starts an app on the screen with `sh -c`, in `cwd` where the screen's apps can see it, and looks at it a moment
   * later. */
  launch(command: string, cwd: string): Promise<Launched>;
  /** One agent-desktop command (its arguments, the command first), and what it printed: the agents' Mac's only. */
  agentDesktop?(args: string): Promise<string>;
  /** The app an agent-desktop command names, as the Mac's app claims know it: the agents' Mac's only. */
  appOf?(target: Target): Promise<App | undefined>;
  /** The display's picture read and encoded where it runs, so only frames cross (a box's display: ./box_frames.ts);
   * absent where the session reads the screen itself. */
  picture?(o: { video: VideoKind; session: string }, on: PictureSink): Promise<PictureRun>;
  /** Throws it away with everything on it. */
  drop(): Promise<void>;
}
