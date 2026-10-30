// The showcase clips' cursor and camera (showcase.spec.ts), worked out from what QA did while recording: each click,
// each run of typing and each look, where on the page (CSS px) and when (this machine's ms). Nothing here is keyed by
// hand: a scene says what to click, type and look at, and its cursor and camera follow from that.
//
// Both move on springs, worked out for every frame of the clip, so they never start or stop with a jolt:
// - The cursor heads for each click along a gentle arc, quicker over a longer way (up to a cap), on a spring a touch
//   under critical damping, so it lands with the slightest settle just before the press; then it dips and springs back.
// - The camera frames the action: it sets off as the cursor does, pushes in on what is typed into, on what is clicked
//   together with what the click changed, and on what a look names, holds, and eases back out to the whole window
//   between steps; steps close together share one move in, panning between. It never zooms past `cap`, the most the
//   recording's pixels allow before text goes soft.
// - Each take opens and ends on the whole window, and the clip ends with the cursor back where it starts, so the cut
//   between takes and the loop's fade both join the same view.

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A step of a scene: a click at `at`, typing from `at` to `until`, or a look from `at` to `until` (the camera on `box`
 * while the app moves on its own, the cursor still), on `box`.
 */
export interface Step {
  readonly kind: "click" | "type" | "look";
  readonly at: number;
  readonly until: number;
  readonly box: Box;
  /** false: the camera stays where it is for this step; a number: zoom to that instead of the step's own. */
  readonly zoom?: false | number;
  /** Where a click changed the page: the camera frames it with the click. */
  readonly effect?: Box;
}

/** What the camera shows: the point at the frame's centre (CSS px) and how far in (1 is the whole window). */
export interface Shot {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface Pointer {
  readonly x: number;
  readonly y: number;
  /** 1 at rest, down to about 0.85 as it clicks. */
  readonly scale: number;
}

export interface Direction {
  readonly shot: Shot;
  readonly pointer: Pointer;
}

export interface Options {
  /** The window, CSS px. */
  readonly view: { readonly width: number; readonly height: number };
  /** The most the camera zooms in. */
  readonly cap: number;
  /** The loop's fade at the end of the last take, ms: cursor and camera are home before it starts. */
  readonly fade: number;
}

type Point = { readonly x: number; readonly y: number };

/** The most zoom on a click's target, and on a field being typed into or a look. */
const ZOOM = { click: 1.5, type: 1.6, look: 1.8 } as const;
/** Room around what the camera frames, CSS px. */
const PAD = 72;
/** How long before a step the camera sets off for it, and how long it holds once the step is over, ms. */
const LEAD = { click: 750, type: 600, look: 400 } as const;
const HOLD = { click: 900, type: 800, look: 0 } as const;
/** Steps nearer than this share one move in, ms. */
const JOIN = 1400;
/** The camera's spring: critically damped, about a second to settle. */
const CAMERA = { omega: 6, zeta: 1 } as const;
/** The cursor's: quick, with the slightest overshoot. */
const CURSOR = { omega: 22, zeta: 0.82 } as const;
/** The click's dip: down to 0.85 and back in about 150 ms. */
const DIP = { omega: 45, zeta: 0.75, depth: 0.85, ms: 55 } as const;
/** The cursor's way to a click: its time grows with the distance, and its speed is capped (CSS px/s). */
const REACH = { base: 300, perPx: 0.35, min: 350, max: 800, speed: 2400 } as const;
/** The cursor's spring trails its way by about this, ms: the way ends this long before the press. */
const TRAIL = 140;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const centre = (b: Box): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
/** The minimum-jerk curve: a hand's bell-shaped speed from rest to rest. */
const minJerk = (u: number) => {
  const v = clamp(u, 0, 1);
  return 10 * v ** 3 - 15 * v ** 4 + 6 * v ** 5;
};

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

/** The most zoom at which `box` and some room around it still fit. */
const fit = (box: Box, view: Options["view"]) => Math.min(view.width / (box.width + 2 * PAD), view.height / (box.height + 2 * PAD));

/** The shot centred on `c` at `zoom`, kept inside the window. */
function inside(c: Point, zoom: number, view: Options["view"]): Shot {
  const halfW = view.width / zoom / 2;
  const halfH = view.height / zoom / 2;
  return { x: clamp(c.x, halfW, view.width - halfW), y: clamp(c.y, halfH, view.height - halfH), zoom };
}

/** A damped spring in one dimension, stepped in small fixed slices so its motion is the same at any frame rate. */
class Spring {
  v = 0;
  constructor(
    public x: number,
    private readonly omega: number,
    private readonly zeta: number,
  ) {}
  step(target: number, ms: number) {
    for (let left = ms; left > 0; left -= 1) {
      const dt = Math.min(1, left) / 1000;
      this.v += (this.omega * this.omega * (target - this.x) - 2 * this.zeta * this.omega * this.v) * dt;
      this.x += this.v * dt;
    }
  }
  reset(x: number) {
    this.x = x;
    this.v = 0;
  }
}

/** Where the camera is headed from when: a take's shots, in time order. */
function cameraPlan(steps: readonly Step[], take: readonly [number, number], end: number, o: Options): Array<{ at: number; shot: Shot }> {
  const whole: Shot = { x: o.view.width / 2, y: o.view.height / 2, zoom: 1 };
  const focus = steps
    .filter((s) => s.zoom !== false && s.until >= take[0] && s.at <= take[1])
    .toSorted((a, b) => a.at - b.at)
    .map((s) => {
      const box = s.effect === undefined ? s.box : union(s.box, s.effect);
      const zoom = clamp(typeof s.zoom === "number" ? s.zoom : Math.min(ZOOM[s.kind], fit(box, o.view)), 1, o.cap);
      return { shot: inside(centre(box), zoom, o.view), from: Math.max(take[0], s.at - LEAD[s.kind]), done: s.until + HOLD[s.kind] };
    })
    .filter((f) => f.shot.zoom >= 1.08 && f.from < end);
  const plan: Array<{ at: number; shot: Shot }> = [{ at: take[0], shot: whole }];
  for (const [k, f] of focus.entries()) {
    plan.push({ at: f.from, shot: f.shot });
    const next = focus[k + 1];
    // Back out once the step is done, unless the next one is near: then straight on to it.
    if (next === undefined || next.from - f.done >= JOIN) plan.push({ at: Math.min(f.done, end), shot: whole });
  }
  return plan.toSorted((a, b) => a.at - b.at);
}

/**
 * The cursor and camera at each of `times` (ascending, ms), from the steps. Before the first take they hold as it
 * opens (the loop's fade blends the end into those frames).
 */
export function direct(steps: readonly Step[], takes: ReadonlyArray<readonly [number, number]>, o: Options, times: readonly number[]): Direction[] {
  const first = takes[0]?.[0] ?? 0;
  const last = takes.at(-1)?.[1] ?? first;
  const home = last - o.fade - 60;
  const whole: Shot = { x: o.view.width / 2, y: o.view.height / 2, zoom: 1 };
  // The camera is settled on the whole window by the end of each take: it heads out a second before.
  const plans = takes.map((take, n) => ({ take, plan: cameraPlan(steps, take, (n === takes.length - 1 ? home : take[1]) - 1100, o) }));

  // The cursor's way: a point that moves along an arc to each click, which the cursor's spring follows.
  const clicks = steps.filter((s) => s.kind === "click").toSorted((a, b) => a.at - b.at);
  const opening = clicks.findLast((c) => c.at <= first + 150);
  const after = clicks.find((c) => c.at > first + 150);
  // It opens where the last click before the first take left it, or a short way from the first click in it.
  const rest: Point =
    opening !== undefined ? centre(opening.box) : after !== undefined ? toward(centre(after.box), { x: o.view.width / 2, y: o.view.height * 0.6 }, 220) : { x: o.view.width * 0.64, y: o.view.height * 0.7 };
  const ways: Array<{ from: number; to: number; a: Point; b: Point }> = [];
  let pos = rest;
  let free = first;
  const go = (b: Point, by: number, earliest: number) => {
    const dist = Math.hypot(b.x - pos.x, b.y - pos.y);
    if (dist < 1) return;
    const ms = Math.max(clamp(REACH.base + REACH.perPx * dist, REACH.min, REACH.max), (dist / REACH.speed) * 1000);
    const from = Math.max(by - ms, earliest);
    ways.push({ from, to: Math.max(by, from + 200), a: pos, b });
    pos = b;
  };
  for (const c of clicks) {
    if (c.at <= first + 150) {
      pos = centre(c.box);
      continue;
    }
    go(centre(c.box), c.at - TRAIL, free);
    free = c.at + 200;
  }
  // And it ends back where it opened, so the loop joins up.
  go(rest, home - 350, free + 300);
  const target = (t: number): Point => {
    let p = rest;
    for (const w of ways) {
      if (t < w.from) break;
      p = t >= w.to ? w.b : arc(w.a, w.b, minJerk((t - w.from) / (w.to - w.from)));
    }
    return p;
  };
  const presses = clicks.filter((c) => c.at > first + 150).map((c) => c.at);

  const camX = new Spring(whole.x, CAMERA.omega, CAMERA.zeta);
  const camY = new Spring(whole.y, CAMERA.omega, CAMERA.zeta);
  const camZ = new Spring(0, CAMERA.omega, CAMERA.zeta);
  const curX = new Spring(rest.x, CURSOR.omega, CURSOR.zeta);
  const curY = new Spring(rest.y, CURSOR.omega, CURSOR.zeta);
  const dip = new Spring(1, DIP.omega, DIP.zeta);
  let now = first;
  let take = -1;
  const out: Direction[] = [];
  for (const time of times) {
    const t = Math.max(time, first);
    const found = plans.findIndex((p) => t <= p.take[1]);
    const n = found === -1 ? plans.length - 1 : found;
    const plan = plans[n];
    if (plan === undefined) throw new Error("no takes");
    if (n !== take) {
      // A cut: the camera opens on the whole window; the cursor goes on from where it was.
      take = n;
      camX.reset(whole.x);
      camY.reset(whole.y);
      camZ.reset(0);
      now = Math.max(now, plan.take[0]);
    }
    // In 4 ms slices, each with its targets then.
    while (now < t) {
      const ms = Math.min(4, t - now);
      now += ms;
      const shot = plan.plan.findLast((p) => p.at <= now)?.shot ?? whole;
      camX.step(shot.x, ms);
      camY.step(shot.y, ms);
      camZ.step(Math.log(shot.zoom), ms);
      const p = target(now);
      curX.step(p.x, ms);
      curY.step(p.y, ms);
      dip.step(presses.some((c) => now >= c && now < c + DIP.ms) ? DIP.depth : 1, ms);
    }
    const zoom = clamp(Math.exp(camZ.x), 1, o.cap);
    out.push({ shot: inside({ x: camX.x, y: camY.x }, zoom, o.view), pointer: { x: curX.x, y: curY.x, scale: dip.x } });
  }
  return out;
}

/** The point `d` from `a` towards `b`, or `b` when that is nearer. */
function toward(a: Point, b: Point, d: number): Point {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return len <= d ? b : { x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len };
}

/** A point `e` of the way from `a` to `b` along a gentle arc, bowed a tenth of the distance to one side. */
function arc(a: Point, b: Point, e: number): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const c = { x: (a.x + b.x) / 2 - dy * 0.1, y: (a.y + b.y) / 2 + dx * 0.1 };
  const v = 1 - e;
  return { x: v * v * a.x + 2 * v * e * c.x + e * e * b.x, y: v * v * a.y + 2 * v * e * c.y + e * e * b.y };
}
