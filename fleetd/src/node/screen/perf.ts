// What a screen's performance panel reads of the machine (contracts' ScreenPerf): once a second, the next frame a screen
// sends carries how many frames it made over that second, how they are made and how long the node's own encoder took,
// the most it may send now and what holds it there, and the machine's CPU and memory then. Only measures, each over the
// second just gone: a still screen sends no frames, so none goes until it moves again. The sender to each viewer (a
// peer's, node/rtc, or the workspace's socket) adds its own link's (flow.ts AckFlow.stats).
//
// Each frame of every kind passes `stamp` on its way out (api.ts LinkArea.send). A session says what only it knows with
// `note`: its encoder, its frame-rate cap and why, and each H.264 frame's encode time.
//
// Pure (docs/CONTRIBUTING.md "The package"): fleetd cloud stamps its own computers' frames with it. The machine's CPU and
// memory come from `machine` (./perf_machine.ts on a node), read only where the process is on the screen's machine.
import type { BrowserFrame, ScreenEncoder, ScreenPerf } from "../../shared/contracts.ts";

/** The machine's cores, CPU busy over them and memory in use, percent, now. */
export type MachineNow = { cores: number; cpuPct?: number; memPct?: number };

/** A stamp goes at most this often per session. */
export const STAMP_EVERY_MS = 1_000;

type Notes = { encoder?: ScreenEncoder; capFps?: number; capBy?: ScreenPerf["capBy"]; encodes: number[] };
type Seen = { at: number; frames: number; bytes: number; total: number };

const notes = new Map<string, Notes>();
const seen = new Map<string, Seen>();

const noteOf = (sessionId: string): Notes => {
  let n = notes.get(sessionId);
  if (n === undefined) {
    n = { encodes: [] };
    notes.set(sessionId, n);
  }
  return n;
};

/** What a session says of its stream now: its encoder, and the most frames a second it sends and why. What held it
 * holds for the whole second the next measures are over: one frame held is enough to say so. */
export function note(sessionId: string, what: { encoder?: ScreenEncoder; capFps?: number; capBy?: ScreenPerf["capBy"] | undefined }): void {
  const n = noteOf(sessionId);
  if (what.encoder !== undefined) n.encoder = what.encoder;
  if (what.capFps !== undefined) n.capFps = what.capFps;
  if (what.capBy !== undefined) n.capBy = what.capBy;
}

/** One H.264 frame the node encoded, `ms` from the frame in to it out. */
export function encoded(sessionId: string, ms: number): void {
  const e = noteOf(sessionId).encodes;
  if (e.length < 240) e.push(ms);
}

/** The session ended: what it noted goes. */
export function forget(sessionId: string): void {
  notes.delete(sessionId);
  seen.delete(sessionId);
}

const median = (xs: number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** A frame on its way out: counted, and carrying the second's measures when one has gone by since the last, with the
 * machine's from `machine`. Without it they're left out: where this process isn't on the screen's machine (fleetd
 * cloud's own link to its computers), they would be another machine's. */
export function stamp(frame: BrowserFrame, now = performance.now(), machine?: (now: number) => MachineNow): void {
  const bytes = Math.floor((frame.jpegB64 ?? frame.h264B64 ?? "").length / 4) * 3;
  const s = seen.get(frame.sessionId);
  if (s === undefined) {
    // The second's rates count the frames after this one.
    seen.set(frame.sessionId, { at: now, frames: 0, bytes: 0, total: 1 });
    return;
  }
  s.frames++;
  s.total++;
  s.bytes += bytes;
  const span = now - s.at;
  if (span < STAMP_EVERY_MS) return;
  const n = noteOf(frame.sessionId);
  const enc = median(n.encodes);
  const m = machine?.(now);
  frame.perf = {
    sent: s.total,
    seq: frame.seq,
    madeFps: Math.round((s.frames * 1000) / span),
    madeKbps: Math.round((s.bytes * 8) / span),
    encoder: n.encoder ?? (frame.h264B64 === undefined ? "jpeg" : "h264"),
    ...(enc === undefined ? {} : { encodeMs: Math.round(enc * 10) / 10 }),
    ...(n.capFps === undefined ? {} : { capFps: n.capFps }),
    ...(n.capBy === undefined ? {} : { capBy: n.capBy }),
    ...(m === undefined ? {} : { cores: m.cores }),
    ...(m?.cpuPct === undefined ? {} : { cpuPct: m.cpuPct }),
    ...(m?.memPct === undefined ? {} : { memPct: m.memPct }),
  };
  n.encodes.length = 0;
  n.capBy = undefined;
  seen.set(frame.sessionId, { at: now, frames: 0, bytes: 0, total: s.total });
}
