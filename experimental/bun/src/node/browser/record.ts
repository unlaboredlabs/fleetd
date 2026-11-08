// A browser session's recording (crates/fleetd/src/node/browser/record.rs, upload.rs): under
// `<home>/browser/recordings/<sessionId>/` its `session.json`, its action log (`actions.jsonl`, each step scrubbed of
// the session's secrets) and its video (`video.webm`: the screencast's JPEGs as an MJPEG Matroska stream into
// ffmpeg's VP9, at FPS frames a second). When the session ends it goes to the hub a piece at a time
// (`browser_recording_part`), reported `uploading` then `recorded`; the folder goes once the hub has it.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { BrowserAction, BrowserControl, BrowserSessionState } from "../../shared/contracts.ts";
import { RECORDING_FILES, RECORDING_PART_BYTES, SCREEN_STEPS_MAX, STEP_ARGS_BYTES, STEP_RESULT_CHARS } from "../../shared/screens_wire.ts";

export const FPS = 25;
const framesAt = (ms: number) => Math.floor((ms * FPS) / 1000);
/** Seven days of tries, then the recording is reported lost. */
export const GIVE_UP_MS = 7 * 24 * 3600_000;

export const recordingsDir = (home: string) => join(home, "browser", "recordings");

/** What a recording's folder says of its session, for an upload after a node restart too. */
export type Meta = {
  sessionId: string;
  kind: string;
  threadId: string;
  cwd: string;
  purpose: string;
  startedAt: string;
  endedAt?: string;
  credentialsFilled: number;
  note?: string;
};

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

/**
 * Masks a session's secrets in what it logs: each value as it is, JSON-escaped, URL-encoded and in base64, as
 * `***NAME***`. TODO(bun): node/mask.rs's thorough masker (every encoding it knows, short values in `value=` only).
 */
export class Scrub {
  private readonly forms: [string, string][];

  constructor(secrets: [string, string][] = []) {
    this.forms = secrets
      .filter(([, v]) => v.length >= 4)
      .flatMap(([name, v]) => {
        const shown = `***${name}***`;
        return [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v), Buffer.from(v).toString("base64")].map(
          (form) => [form, shown] as [string, string],
        );
      })
      .sort((a, b) => b[0].length - a[0].length);
  }

  text(text: string): string {
    let out = text;
    for (const [form, shown] of this.forms) if (form && out.includes(form)) out = out.split(form).join(shown);
    return out;
  }

  value<T>(value: T): T {
    if (typeof value === "string") return this.text(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.value(v)) as T;
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.value(v)])) as T;
    }
    return value;
  }
}

/** A step as the heartbeat carries it: its args only when short, its result cut. */
export function brief(step: BrowserAction): BrowserAction {
  const args = JSON.stringify(step.args ?? {}).length > STEP_ARGS_BYTES ? {} : step.args;
  return { ...step, args, ...(step.result === undefined ? {} : { result: [...step.result].slice(0, STEP_RESULT_CHARS).join("") }) };
}

/** Each session's latest step, newest first, as the heartbeat carries them (record.rs `steps`). */
export class Steps {
  private readonly latest = new Map<string, { at: number; dir: string; step: BrowserAction }>();
  note(dir: string, sessionId: string, step: BrowserAction): void {
    this.latest.set(sessionId, { at: Date.now(), dir, step: brief(step) });
  }
  list(): { sessionId: string; step: BrowserAction }[] {
    for (const [id, s] of this.latest) if (Date.now() - s.at > 24 * 3600_000 || !existsSync(s.dir)) this.latest.delete(id);
    return [...this.latest.entries()]
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, SCREEN_STEPS_MAX)
      .map(([sessionId, s]) => ({ sessionId, step: s.step }));
  }
}

/** Appends a step to the action log, scrubbed. */
export function appendAction(dir: string, action: BrowserAction, scrub: Scrub, steps: Steps, sessionId: string): void {
  const clean = scrub.value(action);
  steps.note(dir, sessionId, clean);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, RECORDING_FILES.actions.name), `${JSON.stringify(clean)}\n`);
}

// ---- the video: MJPEG in Matroska into ffmpeg ----

/** An EBML element's size, in the fewest bytes its marker allows. */
function size(n: number, out: number[]): void {
  let len = 1;
  while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
  const marked = BigInt(n) | (1n << BigInt(7 * len));
  for (let i = len - 1; i >= 0; i--) out.push(Number((marked >> BigInt(8 * i)) & 0xffn));
}
function element(id: number[], body: ArrayLike<number>, out: number[]): void {
  out.push(...id);
  size(body.length, out);
  for (let i = 0; i < body.length; i++) out.push(body[i]!);
}
function uint(id: number[], n: number, out: number[]): void {
  const bytes: number[] = [];
  let v = BigInt(n);
  do {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  } while (v > 0n);
  element(id, bytes, out);
}

/** The stream's header: EBML, an endless segment, its timescale (1 ms) and one MJPEG track of `width` x `height`. */
export function mkvHeader(width: number, height: number): Uint8Array {
  const out: number[] = [];
  const ebml: number[] = [];
  element([0x42, 0x82], [...Buffer.from("matroska")], ebml);
  uint([0x42, 0x87], 4, ebml);
  uint([0x42, 0x85], 2, ebml);
  element([0x1a, 0x45, 0xdf, 0xa3], ebml, out);
  out.push(0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
  const info: number[] = [];
  uint([0x2a, 0xd7, 0xb1], 1_000_000, info);
  element([0x15, 0x49, 0xa9, 0x66], info, out);
  const video: number[] = [];
  uint([0xb0], width, video);
  uint([0xba], height, video);
  const track: number[] = [];
  uint([0xd7], 1, track);
  uint([0x73, 0xc5], 1, track);
  uint([0x83], 1, track);
  element([0x86], [...Buffer.from("V_MJPEG")], track);
  element([0xe0], video, track);
  const entry: number[] = [];
  element([0xae], track, entry);
  element([0x16, 0x54, 0xae, 0x6b], entry, out);
  return Uint8Array.from(out);
}

/** One frame as a cluster at `atMs`, shown for `showsMs`. */
export function mkvFrame(jpeg: Uint8Array, atMs: number, showsMs: number): Uint8Array {
  const head: number[] = [];
  const blockLen = jpeg.length + 4;
  // BlockGroup > Block, written around the JPEG without copying it into an array of numbers.
  const blockHead: number[] = [0xa1];
  size(blockLen, blockHead);
  blockHead.push(0x81, 0, 0, 0);
  const duration: number[] = [];
  uint([0x9b], showsMs, duration);
  const groupLen = blockHead.length + jpeg.length + duration.length;
  const time: number[] = [];
  uint([0xe7], atMs, time);
  const groupHead: number[] = [0xa0];
  size(groupLen, groupHead);
  const clusterLen = time.length + groupHead.length + groupLen;
  head.push(0x1f, 0x43, 0xb6, 0x75);
  size(clusterLen, head);
  return Buffer.concat([Uint8Array.from([...head, ...time, ...groupHead, ...blockHead]), jpeg, Uint8Array.from(duration)]);
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

/** The session's video: each screencast frame held until the next, so the stream keeps FPS frames a second. */
export class VideoSink {
  private readonly child: Subprocess<"pipe", "ignore", "pipe">;
  private held: { jpeg: Uint8Array; tick: number } | undefined;
  private started = false;
  private broken: string | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    ffmpeg: string,
    out: string,
    private readonly sizeOf: [number, number],
  ) {
    const [w, h] = sizeOf;
    this.child = Bun.spawn(
      [
        ffmpeg,
        ...["-loglevel", "error", "-f", "matroska", "-fpsprobesize", "0", "-probesize", "32", "-analyzeduration", "0"],
        ...["-i", "pipe:0", "-y", "-an", "-r", String(FPS), "-c:v", "libvpx-vp9"],
        ...["-qmin", "0", "-qmax", "50", "-crf", "8", "-deadline", "realtime", "-speed", "8", "-b:v", "1M", "-threads", "1"],
        ...["-lag-in-frames", "0", "-vf", `pad=${w}:${h}:0:0:gray,crop=${w}:${h}:0:0`, "-pix_fmt", "yuv420p", out],
      ],
      { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
    );
  }

  private write(until: number, own: number): void {
    const held = this.held;
    if (!held) return;
    const ms = (tick: number) => Math.floor((tick * 1000) / FPS);
    const parts: Uint8Array[] = this.started ? [] : [mkvHeader(...this.sizeOf)];
    const cut = Math.max(until - own, held.tick + 1);
    parts.push(mkvFrame(held.jpeg, ms(held.tick), ms(cut - held.tick)));
    for (let tick = cut; tick < until; tick++) parts.push(mkvFrame(held.jpeg, ms(tick), ms(1)));
    try {
      for (const p of parts) this.child.stdin.write(p);
      void this.child.stdin.flush();
      this.started = true;
    } catch (e) {
      this.broken = `ffmpeg stopped taking frames (${(e as Error).message})`;
    }
  }

  /** A frame of the screencast, `atMs` into the session. */
  frame(jpeg: Uint8Array, atMs: number): void {
    if (this.broken) return;
    const tick = framesAt(atMs);
    const from = this.held?.tick ?? 0;
    if (from < tick) {
      this.held ??= { jpeg, tick: 0 };
      this.write(tick, 1);
    }
    this.held = { jpeg, tick: Math.max(from, tick) };
  }

  /** Called each second: a still page's frame keeps showing. */
  tick(atMs: number): void {
    const due = framesAt(atMs);
    if (this.held && this.held.tick + FPS < due) {
      this.write(due - 1, 1);
      this.held.tick = due - 1;
    }
  }

  /** Ends the stream at `atMs` and waits for ffmpeg to finish the file; why it failed, else undefined. */
  async finish(atMs: number): Promise<string | undefined> {
    if (this.broken) return this.broken;
    if (this.held) this.write(Math.max(framesAt(atMs), this.held.tick + 1), 2);
    await this.child.stdin.end();
    const code = await Promise.race([this.child.exited, Bun.sleep(60_000).then(() => "timeout" as const)]);
    if (code === "timeout") {
      this.child.kill("SIGKILL");
      return "ffmpeg did not finish the video in 60 s";
    }
    if (code !== 0) {
      const said = (await new Response(this.child.stderr).text()).trim().split("\n").at(-1) ?? "";
      return `ffmpeg failed (${code})${said ? `: ${[...said].slice(0, 200).join("")}` : ""}`;
    }
    return undefined;
  }
}

// ---- upload ----

export type HubCall = (thread: string, cwd: string, op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export function report(meta: Meta, state: BrowserSessionState, control: BrowserControl, sent: [string, number][]): Record<string, unknown> {
  return {
    sessionId: meta.sessionId,
    kind: meta.kind,
    threadId: meta.threadId,
    purpose: [...meta.purpose].slice(0, 200).join(""),
    state,
    control,
    startedAt: meta.startedAt,
    ...(meta.endedAt ? { endedAt: meta.endedAt } : {}),
    files: sent.map(([file, bytes]) => ({ file, bytes })),
    credentialsFilled: meta.credentialsFilled,
    ...(meta.note ? { note: [...meta.note].slice(0, 500).join("") } : {}),
  };
}

async function sendFile(hub: HubCall, meta: Meta, dir: string, file: keyof typeof RECORDING_FILES): Promise<number> {
  const bytes = readFileSync(join(dir, RECORDING_FILES[file].name));
  for (let offset = 0; offset < bytes.length; offset += RECORDING_PART_BYTES) {
    const piece = bytes.subarray(offset, offset + RECORDING_PART_BYTES);
    const answer = await hub(meta.threadId, meta.cwd, "browser_recording_part", {
      sessionId: meta.sessionId,
      file,
      offset,
      dataB64: piece.toString("base64"),
    });
    if (answer.bytes !== offset + piece.length) throw new Error(`the hub answered a piece with ${JSON.stringify(answer)}`);
  }
  return bytes.length;
}

/** Sends a finished recording to the hub: `uploading`, each file in pieces, then `recorded`; then its folder goes. */
export async function upload(hub: HubCall, dir: string): Promise<void> {
  const meta = readMeta(dir);
  if (!meta) throw new Error(`${dir} has no readable session file`);
  await hub(meta.threadId, meta.cwd, "browser_session", report(meta, "uploading", "agent", []));
  const sent: [string, number][] = [];
  for (const [file] of files(dir)) sent.push([file, await sendFile(hub, meta, dir, file)]);
  await hub(meta.threadId, meta.cwd, "browser_session", report(meta, "recorded", "agent", sent));
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
