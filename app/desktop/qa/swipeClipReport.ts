// The numbers of swipeClip.spec.ts's scenes (qa-results/clip/<scene>/clip.json), one markdown row a scene: how its
// frames came, how closely the list kept to the fingers, and how long after the lift it was still. Usage: node
// qa/swipeClipReport.ts [qa-results/clip]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

interface Clip {
  readonly scene: string;
  readonly from: number;
  readonly to: number;
  /** [ms, the list's offset, the beside list's, moving 1/0] a frame the page drew. */
  readonly frames: ReadonlyArray<readonly [number, number, number, number]>;
  /** [its ms, handled ms, dx, dy, cancelable, momentum] a wheel event. */
  readonly wheels: ReadonlyArray<readonly [number, number, number, number, number, number]>;
  readonly longs: ReadonlyArray<readonly [number, number]>;
  readonly support: { readonly momentum: boolean };
}

const FRAME = 1000 / 60;

export interface Numbers {
  readonly scene: string;
  readonly hubs: string;
  /** Frames drawn from the first wheel event until it was still, and the ones missed among them. */
  readonly frames: number;
  readonly dropped: number;
  readonly worst: number;
  /** While the fingers moved: how far the list was behind them (px), at most. */
  readonly behind: number;
  /** After the last finger event: until the list began moving toward where it settles, and until it was still (ms). */
  readonly hold: number;
  readonly settle: number;
  /** The furthest it went (px), its give past an end included. */
  readonly reach: number;
  readonly longs: number;
}

export const numbers = (c: Clip): Numbers => {
  const fingers = c.wheels.filter((w) => w[5] === 0);
  const first = c.wheels[0]?.[0] ?? 0;
  const lift = (fingers.at(-1) ?? c.wheels.at(-1))?.[0] ?? first;
  // The last frame that moved: its offset changed, or the list was still marked moving.
  let end = first;
  for (let i = 1; i < c.frames.length; i++) {
    const [t, x, b, m] = c.frames[i] ?? [0, 0, 0, 0];
    const [, px, pb, pm] = c.frames[i - 1] ?? [0, 0, 0, 0];
    if (t > first && (m === 1 || pm === 1 || x !== px || (b !== pb && !Number.isNaN(b)))) end = t;
  }
  const during = c.frames.filter(([t]) => t >= first && t <= end);
  let dropped = 0;
  let worst = 0;
  for (let i = 1; i < during.length; i++) {
    const dt = (during[i]?.[0] ?? 0) - (during[i - 1]?.[0] ?? 0);
    worst = Math.max(worst, dt);
    dropped += Math.max(0, Math.round(dt / FRAME) - 1);
  }
  // Where the fingers had the list at each frame: their travel so far, the list moving the other way.
  let behind = 0;
  for (const [t, x] of during) {
    if (t > lift + FRAME) break;
    const travel = -fingers.filter((w) => w[0] <= t).reduce((s, w) => s + w[2], 0);
    // Toward a hub there, 1:1; toward an end, any give at all is following.
    if (c.from !== c.to || Math.abs(travel) < 40) behind = Math.max(behind, Math.abs(travel - x));
  }
  const after = c.frames.filter(([t]) => t > lift);
  let hold = 0;
  for (let i = 1; i < after.length; i++) {
    const [t, x] = after[i] ?? [0, 0];
    const [, px] = after[i - 1] ?? [0, 0];
    // Toward 0 (back, or the next list's place: it lands there and is redrawn at 0) or on across, at a pixel a frame.
    const toward = c.from === c.to ? Math.abs(x) < Math.abs(px) - 0.5 : Math.abs(x - px) > 0.5;
    if (toward) {
      hold = (after[i - 1]?.[0] ?? t) - lift;
      break;
    }
  }
  return {
    scene: c.scene,
    hubs: `${String(c.from)}→${String(c.to)}`,
    frames: during.length,
    dropped,
    worst: Math.round(worst),
    behind: Math.round(behind),
    hold: Math.max(0, Math.round(hold)),
    settle: Math.max(0, Math.round(end - lift)),
    reach: Math.round(Math.max(...during.map(([, x]) => Math.abs(x)), 0)),
    longs: c.longs.filter(([t]) => t >= first && t <= end).length,
  };
};

export const table = (rows: readonly Numbers[]): string =>
  [
    "| scene | hubs | frames | dropped | worst gap (ms) | list behind fingers (px) | still after lift (ms) | lift → settled (ms) | reach (px) | long frames |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.scene} | ${r.hubs} | ${String(r.frames)} | ${String(r.dropped)} | ${String(r.worst)} | ${String(r.behind)} | ${String(r.hold)} | ${String(r.settle)} | ${String(r.reach)} | ${String(r.longs)} |`),
  ].join("\n");

if (import.meta.main) {
  const dir = process.argv[2] ?? path.join(import.meta.dirname, "..", "qa-results", "clip");
  const rows = readdirSync(dir)
    .filter((d) => existsSync(path.join(dir, d, "clip.json")))
    .map((d) => numbers(JSON.parse(readFileSync(path.join(dir, d, "clip.json"), "utf8")) as Clip));
  console.log(table(rows));
}
