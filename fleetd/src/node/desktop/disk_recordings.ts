// The node's desktop recordings (a `RecordingStore`, node/browser/recording.ts): each session's in a folder of its own
// under `<home>/desktop/recordings/`, as a browser session's is (node/browser/record.ts): its `session.json`, its
// action log and its video, made by an ffmpeg from the session's first frame on, at that frame's size (a Mac screen's
// is its own). Once the session ends it goes to the hub a piece at a time, tried again at each sweep until it does,
// with any a Rust node's iOS screens left.
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RECORDING_FILES } from "../../shared/screens_wire.ts";
import { jpegSize } from "../browser/fit.ts";
import { files, type HubCall, type Meta, type Recording, type RecordingStore, scrubFile, Uploads, type Video, VideoSink, writeMeta } from "../browser/record.ts";
import { NO_VIDEO } from "./session.ts";

/** A video whose ffmpeg starts with the first frame, at its size: a session that never shows one has none. */
class FirstFrameVideo implements Video {
  private sink: VideoSink | undefined;
  private failed: string | undefined;

  constructor(
    private readonly ffmpeg: string,
    private readonly out: string,
  ) {}

  frame(jpeg: Uint8Array, atMs: number): void {
    if (!this.sink && this.failed === undefined) {
      const size = jpegSize(jpeg);
      if (!size) return;
      try {
        this.sink = new VideoSink(this.ffmpeg, this.out, size);
      } catch (e) {
        this.failed = (e as Error).message;
      }
    }
    this.sink?.frame(jpeg, atMs);
  }

  tick(atMs: number): void {
    this.sink?.tick(atMs);
  }

  async finish(atMs: number): Promise<string | undefined> {
    if (this.failed !== undefined) return this.failed;
    return this.sink?.finish(atMs);
  }
}

export class DiskDesktopRecordings implements RecordingStore {
  private readonly uploads: Uploads;

  /** `root`: where this kind's recordings are kept; `left`: folders of recordings others left, sent too. */
  constructor(
    readonly root: string,
    hub: HubCall,
    private readonly ffmpeg: () => string | undefined,
    private readonly left: string[] = [],
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
    const videoFile = join(dir, RECORDING_FILES.video.name);
    const video = ffmpeg ? new FirstFrameVideo(ffmpeg, videoFile) : undefined;
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
          rmSync(videoFile, { force: true });
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
        void this.uploads.send(dir);
        return { files: made, ...(why ? { note: why } : {}) };
      },
    };
  }

  async sweep(live: string[], now: number): Promise<void> {
    await this.uploads.sweep(this.root, live, now);
    for (const root of this.left) await this.uploads.sweep(root, [], now);
  }
}
