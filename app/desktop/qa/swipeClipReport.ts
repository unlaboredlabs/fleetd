// The numbers of swipeClip.spec.ts's scenes (qa-results/clip/<scene>/clip.json), one markdown row a scene: how its
// frames came, how closely the list kept to the fingers, and how long after the lift it was still. Usage: node
// qa/swipeClipReport.ts [qa-results/clip]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

interface Clip {
  readonly scene: string;
  readonly from: number;
  readonly to: number;
  /** [ms, the list's offset, the beside list's, moving 1/0, wheel events handled by then] a frame the page drew. */
  readonly frames: ReadonlyArray<readonly [number, number, number, number, number?]>;
  /** [its ms, handled ms, dx, dy, cancelable, momentum] a wheel event. */
  readonly wheels: ReadonlyArray<readonly [number, number, number, number, number, number]>;
  readonly longs: ReadonlyArray<readonly [number, number]>;
  readonly support: { readonly momentum: boolean };
}

const FRAME = 1000 / 60;

export interface Numbers {
  readonly scene: string;
  readonly hubs: string;
  /**
   * Frames drawn from the first wheel event until it was still, the ones missed among them while the list moved, and
   * the longest one then (ms): a frame across which the list didn't move missed nothing of it. Apart, the frame it landed on another hub in (ms): the list in its place already, the
   * new hub's sidebar and chat drawn.
   */
  readonly frames: number;
  readonly dropped: number;
  readonly worst: number;
  readonly landing: number;
  /** Toward a hub, while the fingers moved: how far the list was off them (px), at most. */
  readonly behind: number;
  /** How long before the fingers' last event the list let go of them and went its own way (ms; 0: never). */
  readonly early: number;
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
  const reach = Math.max(...during.map(([, x]) => Math.abs(x)), 0);
  let dropped = 0;
  let worst = 0;
  let landing = 0;
  for (let i = 1; i < during.length; i++) {
    const [t, x] = during[i] ?? [0, 0];
    const [pt, px] = during[i - 1] ?? [0, 0];
    const dt = t - pt;
    // The one that draws the new hub's list in place, its slide's list a step from the end before it.
    if (c.from !== c.to && x === 0 && Math.abs(px) > reach - 4) {
      landing = Math.round(dt);
      continue;
    }
    // The list still across it (in its place, the new hub's chat opening): no motion missed.
    if (x === px) continue;
    worst = Math.max(worst, dt);
    dropped += Math.max(0, Math.round(dt / FRAME) - 1);
  }
  // Where the fingers had the list at each frame: their travel so far, the list moving the other way. Toward a hub
  // there, 1:1; toward an end, stretched, so only whether it turned back while they still went out.
  const edge = c.scene.startsWith("edge");
  let behind = 0;
  let early = 0;
  let out = 0;
  for (const [t, x, , , seen] of during) {
    if (t > lift) break;
    // The fingers' events handled by the time the frame was drawn.
    const handled = seen === undefined ? c.wheels.filter((w) => w[1] <= t) : c.wheels.slice(0, seen);
    const travel = -handled.filter((w) => w[5] === 0).reduce((s, w) => s + w[2], 0);
    if (!edge) behind = Math.max(behind, Math.abs(travel - x));
    if (Math.abs(x) < out - 0.5 && early === 0) early = lift - t;
    out = Math.max(out, Math.abs(x));
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
    landing,
    behind: Math.round(behind),
    early: Math.round(early),
    hold: Math.max(0, Math.round(hold)),
    settle: Math.max(0, Math.round(end - lift)),
    reach: Math.round(reach),
    longs: c.longs.filter(([t]) => t >= first && t <= end).length,
  };
};

export const table = (rows: readonly Numbers[]): string =>
  [
    "| scene | workspaces | frames | dropped | longest frame (ms) | landing frame (ms) | off the fingers (px) | let go before the lift (ms) | still after the lift (ms) | lift → still (ms) | furthest (px) | long frames |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.scene} | ${r.hubs} | ${String(r.frames)} | ${String(r.dropped)} | ${String(r.worst)} | ${r.landing === 0 ? "–" : String(r.landing)} | ${r.scene.startsWith("edge") ? "–" : String(r.behind)} | ${String(r.early)} | ${String(r.hold)} | ${String(r.settle)} | ${String(r.reach)} | ${String(r.longs)} |`,
    ),
  ].join("\n");

if (import.meta.main) {
  const dir = process.argv[2] ?? path.join(import.meta.dirname, "..", "qa-results", "clip");
  const rows = readdirSync(dir)
    .filter((d) => existsSync(path.join(dir, d, "clip.json")))
    .map((d) => numbers(JSON.parse(readFileSync(path.join(dir, d, "clip.json"), "utf8")) as Clip));
  console.log(table(rows));
}
