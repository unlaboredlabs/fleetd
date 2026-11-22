// What a live view's screen and its encoders say to each other, with nothing of the machine's: the frames of a
// screen's own stream (./mac_frames.ts, fleetd-frames on the agents' Mac), the commands it takes, and an H.264
// encoder's shape (./x264.ts) as a session is handed one. Pure (docs/CONTRIBUTING.md "The package"): the sessions
// the package exports import it, and the node's own entry points make the encoders and streams.

/** A command to a screen's stream: frames as JPEG or H.264, a keyframe next, a still now, the H.264 bit rate, the
 * frame rate, the picture's longer side; and on a stream that takes input (StreamRun `input`), a person's: a finger in
 * the screen's pixels (`edge` 0, or the edge it starts at: 1 top, 2 left, 3 bottom, 4 right), a key by its USB HID
 * usage, the home button. */
export type Command =
  | "jpeg"
  | "h264"
  | "key"
  | "still"
  | `kbps ${number}`
  | `fps ${number}`
  | `side ${number}`
  | `touch ${"down" | "move" | "up"} ${number} ${number} ${number}`
  | `keyboard ${number} ${"down" | "up"}`
  | "button home";

/** A frame of a screen's stream. `screen` is the screen's own size (input coordinates are in it); the picture may be
 * smaller. */
export type StreamFrame = { kind: "jpeg" | "h264"; key: boolean; screen: [number, number]; data: Uint8Array };

/** A running stream: `still` asks for the screen now (a JPEG), changed or not; `tell` gives it a command; `ended`
 * says why it stopped by itself; `input` whether it takes a person's input itself now. */
export type StreamRun = { still(): void; tell(command: Command): void; stop(): void; ended: Promise<string | undefined>; input?: () => boolean };

/** One encoded frame: an access unit in Annex B, its parameter sets first on a keyframe. */
export type Encoded = { data: Uint8Array; key: boolean };

/** What frames go into an encoder: a screen's raw pixels (32 bits each, BGRA in memory) at its size, or JPEGs of a
 * size. */
export type Input = { raw: [number, number] } | { jpeg: [number, number] };

/** A live view's encoder over its life (x264.ts's LiveEncoder): `put` answers false when the frame didn't go (none
 * yet, or none at all: the screen sends JPEG). */
export type LiveEncoding = { key(): void; put(input: Input, data: Uint8Array, kbps: number | undefined): boolean; stop(): void };

/** Makes a session's encoder, its frames to `onFrame`; `onFail` once it can't encode. */
export type MakeEncoder = (onFrame: (frame: Encoded, input: Input) => void, onFail: (why: string) => void) => LiveEncoding;

/** The H.264 bit rate at most, in kbit/s: 1280×800 at 30 fps, text sharp. */
export const MAX_KBPS = 2_500;

/** The share of the watchers' links H.264 takes when they are its bound. */
export const LINK_SHARE = 0.7;

/** The bit rate for watchers whose links carry `kbps` (undefined: they keep up). */
export const kbpsFor = (kbps: number | undefined) => (kbps === undefined ? MAX_KBPS : Math.min(MAX_KBPS, Math.max(100, Math.round(kbps * LINK_SHARE))));
