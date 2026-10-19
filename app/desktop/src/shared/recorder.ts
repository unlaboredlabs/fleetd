// What the recorder page (src/renderer/demo/recorder.ts) offers main, which drives it with executeJavaScript. It
// has no preload and no IPC channel: main calls these and pulls the encoded bytes back, so the app's own IPC
// allowlist stays as it is.

/** The full capture (`fleetd.mp4`) or the clip (`clip.mp4`). */
export type Take = "full" | "clip";

/** The macOS window buttons, in window points, with their fills and rims (active and inactive). */
export interface Lights {
  readonly centers: ReadonlyArray<readonly [number, number]>;
  readonly radius: number;
  readonly active: ReadonlyArray<readonly [string, string]>;
  readonly inactive: readonly [string, string];
}

export interface RecorderStart {
  readonly fps: number;
  /** Physical pixels: the window's content size times its scale factor. */
  readonly width: number;
  readonly height: number;
  /** The content width in points, for drawing in window coordinates. */
  readonly contentWidth: number;
  readonly bitrate: number;
  /** The traffic lights to paint over the capture (macOS), or null. */
  readonly lights: Lights | null;
}

export type Chunk =
  | { readonly take: Take; readonly bytes: Uint8Array }
  /** The take's recorder stopped and every byte before this was handed over. */
  | { readonly take: Take; readonly end: true }
  | { readonly take: Take; readonly error: string };

export interface RecorderApi {
  /** Resolves with the container MediaRecorder chose; rejects when the window can't be captured. */
  start(options: RecorderStart): Promise<string>;
  clipStart(): void;
  stop(take: Take): void;
  /** Everything encoded since the last call, in order. */
  drain(): Promise<ReadonlyArray<Chunk>>;
  /** The window's focus, which greys the traffic lights out as macOS does. */
  setActive(active: boolean): void;
  /** The current frame as PNG, lights included; null before the first frame. */
  still(): Promise<Uint8Array | null>;
}

export const RECORDER_GLOBAL = "__fleetdRecorder";
/** H.264 in MP4: VideoToolbox on macOS, OpenH264 on Linux; Chromium muxes it, so there's no ffmpeg anywhere. */
export const RECORDER_MIME = "video/mp4;codecs=avc1";
