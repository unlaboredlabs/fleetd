// A browser session's recording (upload.rs): under
// `<home>/browser/recordings/<sessionId>/` its `session.json`, its action log (`actions.jsonl`, each step scrubbed of
// the session's secrets) and its video (`video.webm`: the screencast's JPEGs as an MJPEG Matroska stream into
// ffmpeg's VP9, at FPS frames a second). When the session ends it goes to the hub a piece at a time
// (`browser_recording_part`), reported `uploading` then `recorded`; the folder goes once the hub has it. An upload cut
// short (a dropped link, a node restart) goes on from the last piece the hub took (`sent.json`), not from the start.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { BrowserAction } from "../../shared/contracts.ts";
import type { Scrub } from "../mask.ts";
import { RECORDING_FILES, RECORDING_PART_BYTES } from "../../shared/screens_wire.ts";
import { FPS, GIVE_UP_MS, H264Video, type HubCall, type Meta, MkvVideo, type Recording, type RecordingStore, report, Steps as KeptSteps, type VideoWriter } from "./recording.ts";

export {
  brief,
  FPS,
  GIVE_UP_MS,
  H264Video,
  type HubCall,
  type Meta,
  MkvVideo,
  mkvFrame,
  mkvHeader,
  type Recording,
  type RecordingStore,
  report,
  type Video,
  type VideoWriter,
} from "./recording.ts";

/** Each session's latest step, as long as its recording's folder is there. */
export class Steps extends KeptSteps {
  constructor() {
    super(existsSync);
  }
}


export const recordingsDir = (home: string) => join(home, "browser", "recordings");


export function writeMeta(dir: string, meta: Meta): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const next = join(dir, "session.json.next");
  writeFileSync(next, JSON.stringify(meta), { mode: 0o600 });
  renameSync(next, join(dir, "session.json"));
}

export function readMeta(dir: string): Meta | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as Meta;
  } catch {
    return undefined;
  }
}

/** The recording's files there are, and their sizes. */
export function files(dir: string): [keyof typeof RECORDING_FILES, number][] {
  return (Object.keys(RECORDING_FILES) as (keyof typeof RECORDING_FILES)[]).flatMap((f) => {
    try {
      const size = statSync(join(dir, RECORDING_FILES[f].name)).size;
      return size > 0 ? [[f, size] as [keyof typeof RECORDING_FILES, number]] : [];
    } catch {
      return [];
    }
  });
}

/** What a recording scrubs: the full masker (node/mask.ts). */
export { Scrub } from "../mask.ts";

/** The action log (or any text file of the recording) scrubbed once more whole, with every secret known. */
export function scrubFile(path: string, scrub: Scrub): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const scrubbed = scrub.text(text);
  if (scrubbed !== text) writeFileSync(path, scrubbed, { mode: 0o600 });
}


/** Appends one scrubbed JSON line to a recording file (the DOM trace's). */
export function appendLine(dir: string, file: string, item: unknown, scrub: Scrub): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, file), `${JSON.stringify(scrub.value(item))}\n`);
}

/** Appends a step to the action log, scrubbed. */
export function appendAction(dir: string, action: BrowserAction, scrub: Scrub, steps: KeptSteps, sessionId: string): void {
  const clean = scrub.value(action);
  steps.note(dir, sessionId, clean);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, RECORDING_FILES.actions.name), `${JSON.stringify(clean)}\n`);
}


/** Playwright's ffmpeg in an install directory (chrome.rs `find_ffmpeg`). */
export function findFfmpeg(root: string): string | undefined {
  try {
    const dirs = readdirSync(root).filter((n) => n.startsWith("ffmpeg-") && existsSync(join(root, n, "INSTALLATION_COMPLETE")));
    dirs.sort((a, b) => Number(b.slice(7)) - Number(a.slice(7)));
    for (const d of dirs) for (const bin of ["ffmpeg-linux", "ffmpeg-mac", "ffmpeg"]) if (existsSync(join(root, d, bin))) return join(root, d, bin);
  } catch {
    // No install.
  }
  return undefined;
}


/** The session's video into Playwright's ffmpeg, to VP9 in `out`. */
export class VideoSink extends MkvVideo {
  constructor(ffmpeg: string, out: string, sizeOf: [number, number]) {
    const [w, h] = sizeOf;
    super(
      sizeOf,
      ffmpegWriter(ffmpeg, [
        ...["-i", "pipe:0", "-y", "-an", "-r", String(FPS), "-c:v", "libvpx-vp9"],
        ...["-qmin", "0", "-qmax", "50", "-crf", "8", "-deadline", "realtime", "-speed", "8", "-b:v", "1M", "-threads", "1"],
        ...["-lag-in-frames", "0", "-vf", `pad=${w}:${h}:0:0:gray,crop=${w}:${h}:0:0`, "-pix_fmt", "yuv420p", out],
      ]),
    );
  }
}

/** The session's own H.264 into an ffmpeg that copies it into MP4 at `out` (`video_mp4`), encoding nothing: fragmented,
 * a fragment each keyframe and each 2 s, so a video cut short (the node stopped mid-session) plays up to there. */
export class Mp4Sink extends H264Video {
  constructor(ffmpeg: string, out: string) {
    super(ffmpegWriter(ffmpeg, ["-i", "pipe:0", "-y", "-an", "-c:v", "copy", "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-frag_duration", "2000000", "-f", "mp4", out]));
  }
}

/** An ffmpeg making its output (`args`, from its input on) of the Matroska stream on its stdin. */
function ffmpegWriter(ffmpeg: string, args: string[]): VideoWriter {
  const child: Subprocess<"pipe", "ignore", "pipe"> = Bun.spawn(
    [ffmpeg, ...["-loglevel", "error", "-f", "matroska", "-fpsprobesize", "0", "-probesize", "32", "-analyzeduration", "0"], ...args],
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
  );
  return {
    write(bytes) {
      child.stdin.write(bytes);
      void child.stdin.flush();
    },
    async end() {
      await child.stdin.end();
      const code = await Promise.race([child.exited, Bun.sleep(60_000).then(() => "timeout" as const)]);
      if (code === "timeout") {
        child.kill("SIGKILL");
        return "ffmpeg did not finish the video in 60 s";
      }
      if (code !== 0) {
        const said = (await new Response(child.stderr).text()).trim().split("\n").at(-1) ?? "";
        return `ffmpeg failed (${code})${said ? `: ${[...said].slice(0, 200).join("")}` : ""}`;
      }
      return undefined;
    },
  };
}

// ---- upload ----


/** How much of each file the hub took, as its answers said: where an upload cut short goes on. */
const SENT = "sent.json";
type Sent = Partial<Record<keyof typeof RECORDING_FILES, number>>;

function readSent(dir: string): Sent {
  try {
    return JSON.parse(readFileSync(join(dir, SENT), "utf8")) as Sent;
  } catch {
    return {};
  }
}

async function sendFile(hub: HubCall, meta: Meta, dir: string, file: keyof typeof RECORDING_FILES, sent: Sent): Promise<number> {
  const bytes = readFileSync(join(dir, RECORDING_FILES[file].name));
  const from = sent[file] ?? 0;
  for (let offset = from <= bytes.length ? from : 0; offset < bytes.length; offset += RECORDING_PART_BYTES) {
    const piece = bytes.subarray(offset, offset + RECORDING_PART_BYTES);
    let answer: Record<string, unknown>;
    try {
      answer = await hub(meta.threadId, meta.cwd, "browser_recording_part", {
        sessionId: meta.sessionId,
        file,
        offset,
        dataB64: piece.toString("base64"),
      });
    } catch (e) {
      // The hub holds less than the node thought (it lost what it had): the next try sends the file whole.
      if (offset > 0 && said(e, "would leave a gap")) writeSent(dir, { ...sent, [file]: 0 });
      throw e;
    }
    if (answer.bytes !== offset + piece.length) throw new Error(`the hub answered a piece with ${JSON.stringify(answer)}`);
    sent[file] = offset + piece.length;
    writeSent(dir, sent);
  }
  return bytes.length;
}

/** Whether the hub's refusal (its message or its fix) says `words`. */
const said = (e: unknown, words: string) => `${(e as Error).message} ${(e as { fix?: string }).fix ?? ""}`.includes(words);

function writeSent(dir: string, sent: Sent): void {
  writeFileSync(join(dir, SENT), JSON.stringify(sent));
}

/** Sends a finished recording to the hub: `uploading`, each file in pieces, then `recorded`; then its folder goes. */
export async function upload(hub: HubCall, dir: string): Promise<void> {
  const meta = readMeta(dir);
  if (!meta) throw new Error(`${dir} has no readable session file`);
  await hub(meta.threadId, meta.cwd, "browser_session", report(meta, "uploading", "agent", []));
  const progress = readSent(dir);
  const sent: [string, number][] = [];
  for (const [file] of files(dir)) sent.push([file, await sendFile(hub, meta, dir, file, progress)]);
  try {
    await hub(meta.threadId, meta.cwd, "browser_session", report(meta, "recorded", "agent", sent));
  } catch (e) {
    // The hub's copy of a file is short of it: the next try sends every file whole.
    if (said(e, "again from offset 0")) rmSync(join(dir, SENT), { force: true });
    throw e;
  }
  rmSync(dir, { recursive: true, force: true });
}

/** A recording that couldn't reach the hub in GIVE_UP_MS: reported lost, why, and its folder goes. */
export async function giveUp(hub: HubCall, dir: string, why: string): Promise<void> {
  const meta = readMeta(dir);
  if (meta) {
    await hub(meta.threadId, meta.cwd, "browser_session", report({ ...meta, note: why }, "lost", "agent", []));
  }
  rmSync(dir, { recursive: true, force: true });
}

/** A recording folder this new with no ended session file may be a session still opening (upload.rs `OPENING`). */
export const OPENING_MS = 5 * 60_000;

/** Whether the folder or its session file changed this recently. */
function changedWithin(dir: string, ms: number, now: number): boolean {
  return [dir, join(dir, "session.json")].some((p) => {
    try {
      return now - statSync(p).mtimeMs < ms;
    } catch {
      return false;
    }
  });
}

/**
 * The recordings in `root` waiting to go, but `live` ones (upload.rs `waiting_in`). One a node stopped during (a Rust
 * node's or this one's) is ended now, with a note; a folder with no session file is a start that never got going.
 */
export function waitingIn(root: string, live: string[], now = Date.now()): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (live.includes(name)) continue;
    const dir = join(root, name);
    const meta = readMeta(dir);
    if (!meta?.endedAt && changedWithin(dir, OPENING_MS, now)) continue;
    if (!meta) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (!meta.endedAt) {
      try {
        writeMeta(dir, { ...meta, endedAt: new Date(now).toISOString(), note: "the node stopped during this session; its video may end early" });
      } catch {
        continue;
      }
    }
    out.push(dir);
  }
  return out;
}

/** A screen kind's uploads: one per folder at a time, tried again at each sweep, and one that waited GIVE_UP_MS lost. */
export class Uploads {
  private readonly uploading = new Set<string>();

  constructor(
    private readonly hub: HubCall,
    private readonly what: string,
  ) {}

  async send(dir: string, now = Date.now()): Promise<void> {
    if (this.uploading.has(dir)) return;
    this.uploading.add(dir);
    try {
      await upload(this.hub, dir);
    } catch (e) {
      const why = (e as Error).message;
      console.warn(`${this.what} recording ${dir}: not uploaded yet: ${why}`);
      const ended = readMeta(dir)?.endedAt;
      if (ended && now - Date.parse(ended) >= GIVE_UP_MS) await giveUp(this.hub, dir, `its upload kept failing: ${why}`).catch(() => {});
    } finally {
      this.uploading.delete(dir);
    }
  }

  /** Sends every recording waiting in `root` but the `live` ones. */
  async sweep(root: string, live: string[], now = Date.now()): Promise<void> {
    for (const dir of waitingIn(root, live, now)) await this.send(dir, now);
  }
}

/** What a browser session's recording says without ffmpeg. */
export const NO_VIDEO = "no video: this machine has no ffmpeg for it";

/**
 * The node's recordings (`RecordingStore`): each session's in a folder of its own under `root`, its video made by
 * `ffmpeg` (none: no video), sent to the hub through `hub` once it ends, off the session's end, and tried again at each
 * sweep until it goes; one that waited GIVE_UP_MS is reported lost.
 */
export class DiskRecordings implements RecordingStore {
  /** Recordings on their way to the hub now: one upload per folder, as the Rust broker keeps one `uploading` task. */
  private readonly uploading = new Set<string>();

  constructor(
    readonly root: string,
    private readonly hub: HubCall,
    private readonly ffmpeg: () => string | undefined,
    private readonly size: [number, number],
  ) {}

  open(meta: Meta): Recording {
    const dir = join(this.root, meta.sessionId);
    writeMeta(dir, meta);
    const ffmpeg = this.ffmpeg();
    let video: VideoSink | undefined;
    let note: string | undefined = ffmpeg ? undefined : NO_VIDEO;
    try {
      // A session a holder took over goes on in a video of its own: the one before ended with its ffmpeg.
      video = ffmpeg ? new VideoSink(ffmpeg, join(dir, meta.resumed ? `video-${Date.now()}.webm` : RECORDING_FILES.video.name), this.size) : undefined;
    } catch (e) {
      note = `no video: ${(e as Error).message}`;
    }
    return {
      key: dir,
      video,
      note,
      append: (file, line) => {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        appendFileSync(join(dir, RECORDING_FILES[file].name), `${line}\n`);
      },
      filled: (count) => {
        const now = readMeta(dir);
        if (now) writeMeta(dir, { ...now, credentialsFilled: count });
      },
      end: async (ended, scrub, atMs) => {
        // The text files scrubbed once more whole, with every value the session knew.
        for (const file of [RECORDING_FILES.actions.name, RECORDING_FILES.dom.name]) scrubFile(join(dir, file), scrub);
        let why = ended.note ?? note;
        if (video) {
          const failed = await video.finish(atMs);
          if (failed) why = `no video: ${failed}`;
        }
        const now = readMeta(dir);
        if (now) writeMeta(dir, { ...now, endedAt: ended.endedAt, credentialsFilled: ended.credentialsFilled, ...(why ? { note: why } : {}) });
        const made = files(dir).map(([file, bytes]) => ({ file, bytes }));
        // Off the session's end: a large video takes a while to reach the hub, and the sweep tries again if it doesn't.
        void this.send(dir);
        return { files: made, ...(why ? { note: why } : {}) };
      },
    };
  }

  /** A finished session's recording to the hub; kept for the next try when the hub didn't take it. */
  async send(dir: string): Promise<boolean> {
    // An upload starts at offset 0, which cuts short one still going: never two of one folder.
    if (this.uploading.has(dir)) return false;
    this.uploading.add(dir);
    try {
      await upload(this.hub, dir);
      return true;
    } catch (e) {
      console.warn(`browser recording ${dir}: not uploaded yet: ${(e as Error).message}`);
      return false;
    } finally {
      this.uploading.delete(dir);
    }
  }

  async sweep(live: string[], now: number): Promise<void> {
    // One a stopped node left unended (this one's or a Rust node's) is ended with a note, and goes too.
    for (const dir of waitingIn(this.root, live, now)) {
      const meta = readMeta(dir);
      if (!meta?.endedAt) continue;
      if (now - Date.parse(meta.endedAt) >= GIVE_UP_MS) {
        await giveUp(this.hub, dir, "its recording never reached the hub").catch(() => {});
        continue;
      }
      await this.send(dir);
    }
  }
}
