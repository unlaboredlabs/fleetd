// The node's desktop recordings (a `RecordingStore`, node/browser/recording.ts): each session's in a folder of its own
// under `<home>/desktop/recordings/`, as a browser session's is (node/browser/record.ts): its `session.json`, its
// action log and its video, made by an ffmpeg from the session's first frame on: the session's own H.264 copied into
// `video.mp4` (a Linux desktop's x264, encoded once for the video and the live view), else its JPEGs encoded into
// `video.webm` at the first frame's size (a Mac screen's is its own). Once the session ends and the hub has heard so (`send`, after the desktops' own report), it goes to the
// hub a piece at a time, tried again at each sweep until it does, with any a Rust node's iOS screens left.
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RECORDING_FILES } from "../../shared/screens_wire.ts";
import { jpegSize } from "../browser/fit.ts";
import { files, type HubCall, type Meta, Mp4Sink, readMeta, type Recording, type RecordingStore, scrubFile, Uploads, type Video, VideoSink, writeMeta } from "../browser/record.ts";
import { NO_VIDEO } from "./session.ts";

/** A video whose ffmpeg starts with the first frame: H.264 copied into `dir`'s MP4, or JPEGs encoded into its WebM
 * at the first one's size. A session that never shows a frame has none. */
class FirstFrameVideo implements Video {
  private sink: VideoSink | undefined;
  private mp4: Mp4Sink | undefined;
  private failed: string | undefined;

  constructor(
    private readonly ffmpeg: () => string | undefined,
    private readonly dir: string,
  ) {}

  /** The ffmpeg, as it is now: the one the H.264 encoder fetched may have come since the session started. */
  private start<T>(make: (ffmpeg: string) => T): T | undefined {
    const ffmpeg = this.ffmpeg();
    if (!ffmpeg) {
      this.failed = "this machine has no ffmpeg for it";
      return undefined;
    }
    try {
      return make(ffmpeg);
    } catch (e) {
      this.failed = (e as Error).message;
      return undefined;
    }
  }

  frame(jpeg: Uint8Array, atMs: number): void {
    if (this.mp4) return;
    if (!this.sink && this.failed === undefined) {
      const size = jpegSize(jpeg);
      if (!size) return;
      this.sink = this.start((ffmpeg) => new VideoSink(ffmpeg, join(this.dir, RECORDING_FILES.video.name), size));
    }
    this.sink?.frame(jpeg, atMs);
  }

  h264(au: Uint8Array, key: boolean, size: [number, number], atMs: number): boolean {
    if (this.sink) return false;
    if (!this.mp4 && this.failed === undefined) this.mp4 = this.start((ffmpeg) => new Mp4Sink(ffmpeg, join(this.dir, RECORDING_FILES.video_mp4.name)));
    this.mp4?.frame(au, key, size, atMs);
    return this.mp4 !== undefined;
  }

  tick(atMs: number): void {
    this.sink?.tick(atMs);
  }

  async finish(atMs: number): Promise<string | undefined> {
    if (this.failed !== undefined) return this.failed;
    return (this.mp4 ?? this.sink)?.finish(atMs);
  }

  /** The file it made, if any. */
  file(): string | undefined {
    if (this.mp4) return join(this.dir, RECORDING_FILES.video_mp4.name);
    if (this.sink) return join(this.dir, RECORDING_FILES.video.name);
    return undefined;
  }
}

export class DiskDesktopRecordings implements RecordingStore {
  private readonly uploads: Uploads;

  /** `root`: where this kind's recordings are kept. */
  constructor(
    readonly root: string,
    hub: HubCall,
    private readonly ffmpeg: () => string | undefined,
  ) {
    this.uploads = new Uploads(hub, "desktop");
  }

  open(meta: Meta): Recording {
    const dir = join(this.root, meta.sessionId);
    const ffmpeg = this.ffmpeg();
    const note = ffmpeg ? undefined : NO_VIDEO;
    const write = (m: Meta) => {
      try {
        writeMeta(dir, m);
      } catch (e) {
        console.warn(`desktop ${meta.sessionId}: session file not written: ${(e as Error).message}`);
      }
    };
    write({ ...meta, ...(note ? { note } : {}) });
    const video = ffmpeg ? new FirstFrameVideo(this.ffmpeg, dir) : undefined;
    return {
      key: dir,
      ...(video ? { video } : {}),
      ...(note ? { note } : {}),
      append: (file, line) => {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        appendFileSync(join(dir, RECORDING_FILES[file].name), `${line}\n`);
      },
      filled: () => {},
      end: async (ended, scrub, atMs) => {
        let why = ended.note;
        const failed = await video?.finish(atMs);
        if (failed) {
          const made = video?.file();
          if (made) rmSync(made, { force: true });
          why = why ? `${why}; no video: ${failed}` : `no video: ${failed}`;
        }
        // The action log was scrubbed line by line as it was written; scrubbed once more whole, with every secret known.
        const actions = join(dir, RECORDING_FILES.actions.name);
        try {
          scrubFile(actions, scrub);
        } catch (e) {
          console.warn(`desktop ${meta.sessionId}: recording not scrubbed: ${(e as Error).message}`);
          rmSync(actions, { force: true });
        }
        write({ ...meta, endedAt: ended.endedAt, credentialsFilled: ended.credentialsFilled, ...(why ? { note: why } : {}) });
        const made = files(dir).map(([file, bytes]) => ({ file, bytes }));
        return { files: made, ...(why ? { note: why } : {}) };
      },
    };
  }

  /** Session `id`'s ended recording to the hub, off the caller's step: a large video takes a while, and the sweep
   * tries again if it doesn't go. */
  send(id: string): void {
    const dir = join(this.root, id);
    if (readMeta(dir)?.endedAt) void this.uploads.send(dir);
  }

  async sweep(live: string[], now: number): Promise<void> {
    await this.uploads.sweep(this.root, live, now);
  }
}
