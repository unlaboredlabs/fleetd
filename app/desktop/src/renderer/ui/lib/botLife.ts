// What keeps the bots alive on the desktop (shared/bot.ts): one clock steps every bot that is awake and on screen, and
// stops when none is; and one conductor gives an idle bot in a list its moment (a blink or a glance) every 1.6 to
// 3.6 s, never the same one twice running, so idle rows take turns. A bot in a live state (thinking, working, needs
// you, done, an error) keeps moving while it's on screen. The bots are the one exception to the app's 120 ms motion
// beat (D377): springs at the display's rate, and only while they are seen. Nothing moves while the window is hidden or
// for a bot off screen, whose clock stops there; with reduced motion, or while the window isn't focused, a change
// settles in about 150 ms and then the bot is still.
//
// A bot's canvas is drawn only once its outline has moved MOVED device px (or its eyes' light FADED) since its last
// frame: a breath at list size moves a fraction of a pixel in a second, and every frame the app draws costs the whole
// page's frame (a 60 fps loop for six bots was 15% of a core at rest, `pnpm perf`'s idle CPU). The rig is
// deterministic, so the clock looks ahead on a copy of it for when it next moves that far and sleeps until then (a
// timer, then the frame itself), rather than waking every display frame to find it hasn't; a bot that has moved half
// as far draws along on a frame drawn for another. While you type they hold still too, until HOLD_MS after the last
// key: a frame drawn for them each display frame cost each key press a frame or two on its way to the screen
// (`pnpm perf`'s keypress p95 went from 4 to 35 ms), and their clocks stop, so they go on from where they were.
//
// A bot is drawn on its own canvas, its eyes traced straight from the rig's numbers (traceEyes), so a frame makes no
// strings and touches no DOM. Drawn as an SVG, each frame's new transform and paths left the renderer style and paint
// garbage that only a major GC frees: three bots in live states held 60 MB more of it after 10 s idle (`pnpm perf`'s
// idle memory went from 347 to 412 MB), and writing only what changed didn't lower that, only how soon it got there.
import { advanceRig, BODY, bodyOf, CROP, dimOf, DIMMED, glowOf, isAwake, listRest, moment, paintOf, random, setRigState, traceEyes, type BotState, type Pen, type Rig } from "../../../shared/bot";

interface Member {
  readonly rig: Rig;
  readonly canvas: HTMLCanvasElement;
  /** None where there's no canvas to draw on (a test's DOM). */
  readonly ctx: CanvasRenderingContext2D | null;
  /** Its box's side, in CSS px. */
  readonly box: number;
  /** Its project's color (BOT_PAINT); none: slate. */
  color: string | undefined;
  seen: boolean;
  /** Its outline and light as last drawn (poseOf). */
  readonly drawn: number[];
  /** When, on its own clock, it next moves far enough to draw (ahead); none: not looked for since it last changed. */
  due: number | undefined;
  /** It isn't due to draw then, only to be looked at again: it moves too slowly to draw within HORIZON. */
  recheck: boolean;
  /** The copy of its rig the clock looks ahead on. */
  readonly ahead: Rig;
  /** When its clock last moved on (performance.now()); none while it's stopped: asleep, off screen, or held. */
  at: number | undefined;
}

/** How far the canvas reaches past each side of the box, of its side, so a hop or a slump is never cut off
 * (Bot.module.css's .canvas). */
export const PAD = 0.25;
/** The eyes' glow: their blur's standard deviation, in the body's units. */
const GLOW_BLUR = 2.4;

/** How far a bot's outline moves, in device px, before its canvas is drawn again; and how much its eyes' glow or
 * dimming changes, in alpha. Below a quarter pixel an antialiased edge hardly changes. */
const MOVED = 0.25;
const FADED = 0.01;
/** The display frame the clock looks ahead in, and how far it looks, in seconds. */
const FRAME = 1 / 60;
const HORIZON = 1;

let reducedQuery: MediaQueryList | undefined;
/** The window has the focus: without it the bots settle as with reduced motion, and hold still. */
let focused = true;
const calm = (): boolean => reducedQuery?.matches === true || !focused;

const members = new Map<HTMLCanvasElement, Member>();
const r = random(Math.floor(Math.random() * 2 ** 31));
let conductor: number | undefined;
let frame: number | undefined;
/** The timer that sleeps until the next frame a bot needs. */
let timer: number | undefined;
let lastTurn: Member | undefined;
/** How long the bots hold still after a key press. */
const HOLD_MS = 1200;
let holdUntil = 0;
let held: number | undefined;
let dark = false;
let themes: MutationObserver | undefined;
let pixels: MediaQueryList | undefined;
let body: Path2D | undefined;
/** The eye being traced, reused frame to frame. */
const outline: number[] = [];

/** Device px per unit of the 100 box for `m`, and its canvas's side in device px. */
const sideOf = (m: Member): number => Math.round(m.box * (1 + 2 * PAD) * (window.devicePixelRatio || 1));

/** The outline's points as traced, in the body's space: a pen that keeps where each curve ends. */
let traced: number[] = [];
let ends = 0;
const keeper: Pen = {
  moveTo: (x, y) => {
    traced[ends++] = x;
    traced[ends++] = y;
  },
  bezierCurveTo: (_a, _b, _c, _d, x, y) => {
    traced[ends++] = x;
    traced[ends++] = y;
  },
  closePath: () => undefined,
};
/** The body's own points that show its squash, lean and lift. */
const HULL = [50, 22, 14.5, 60, 85.5, 60, 50, 85];

/** `rig`'s outline in `m`'s canvas, in device px (both eyes and the body's hull), then its eyes' glow and dimming as
 * alpha, into `out`: what a frame shows, to tell whether the next one is new. */
const poseOf = (m: Member, rig: Rig, out: number[]): void => {
  const k = sideOf(m) / (CROP.w * (1 + 2 * PAD));
  traced = out;
  ends = 0;
  traceEyes(rig, keeper, outline);
  for (const v of HULL) out[ends++] = v;
  const [a, b, c, d, e, f] = bodyOf(rig);
  for (let i = 0; i < ends; i += 2) {
    const x = out[i] ?? 0;
    const y = out[i + 1] ?? 0;
    out[i] = k * (a * x + c * y + e);
    out[i + 1] = k * (b * x + d * y + f);
  }
  const paint = paintOf(m.color, dark);
  out[ends] = paint.glowA * glowOf(rig);
  out[ends + 1] = DIMMED * dimOf(rig);
  out.length = ends + 2;
};

/** How far `now` is from `then`, as a share of what makes a new frame: 1 or more draws. */
const moved = (now: readonly number[], then: readonly number[]): number => {
  if (now.length !== then.length) return Infinity;
  let most = 0;
  const n = now.length - 2;
  for (let i = 0; i < n; i++) most = Math.max(most, Math.abs((now[i] ?? 0) - (then[i] ?? 0)) / MOVED);
  for (let i = n; i < now.length; i++) most = Math.max(most, Math.abs((now[i] ?? 0) - (then[i] ?? 0)) / FADED);
  return most;
};

/** Draws `m`'s frame on its canvas, in its color's paint for the theme and at the display's pixel ratio. */
const draw = (m: Member): void => {
  m.due = undefined;
  poseOf(m, m.rig, m.drawn);
  const c = m.ctx;
  if (c === null) return;
  const px = sideOf(m);
  // A new size clears it, and its state with it.
  if (m.canvas.width !== px) m.canvas.width = m.canvas.height = px;
  else {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, px, px);
  }
  // Device pixels to the 100 box's units, with the box's crop (CROP) inside the pad.
  const k = px / (CROP.w * (1 + 2 * PAD));
  const [a, b, cc, d, e, f] = bodyOf(m.rig);
  c.setTransform(k, 0, 0, k, k * (CROP.w * PAD - CROP.x), k * (CROP.w * PAD - CROP.y));
  c.transform(a, b, cc, d, e, f);
  const paint = paintOf(m.color, dark);
  c.fillStyle = paint.body;
  c.fill((body ??= new Path2D(BODY)));
  c.beginPath();
  traceEyes(m.rig, c, outline);
  c.fillStyle = paint.eye;
  const glow = glowOf(m.rig);
  if (glow > 0.001) {
    // The glow is the eyes' blurred shadow beneath them: a shadow's blur is twice its deviation, in device pixels.
    c.globalAlpha = paint.glowA * glow;
    c.shadowColor = paint.eye;
    c.shadowBlur = 2 * GLOW_BLUR * k;
    c.fill();
    c.shadowBlur = 0;
  }
  c.globalAlpha = 1 - DIMMED * dimOf(m.rig);
  c.fill();
  c.globalAlpha = 1;
};

/** Draws every bot again, moving or not: the theme or the pixel ratio changed. */
const redraw = (): void => {
  dark = document.documentElement.dataset["theme"] === "dark";
  for (const m of members.values()) draw(m);
};

/** Watches for the next change of the display's pixel ratio (a window moved to another screen). */
const watchPixels = (): void => {
  pixels?.removeEventListener("change", onPixels);
  pixels = typeof window.matchMedia === "function" ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : undefined;
  pixels?.addEventListener("change", onPixels);
};
const onPixels = (): void => {
  watchPixels();
  redraw();
};

const shown = (m: Member): boolean => m.seen && m.canvas.isConnected;

/** `to` made the same as `from`, its arrays copied. */
const copyRig = (to: Rig, from: Rig): void => {
  Object.assign(to, from, { x: from.x.slice(), v: from.v.slice(), amp: from.amp.slice(), ampV: from.ampV.slice(), blinks: from.blinks.slice() });
};

const ahead: number[] = [];
/** Looks ahead on a copy of `m`'s rig, a display frame at a time, for when it has moved far enough from its last
 * frame to draw again, up to HORIZON: its due time on its own clock. One that falls asleep first without moving that
 * far takes the copy's place at once, as nothing of it would show, and is due never. */
const lookAhead = (m: Member, still: boolean): void => {
  const r = m.ahead;
  copyRig(r, m.rig);
  for (let s = FRAME; s <= HORIZON + FRAME / 2; s += FRAME) {
    advanceRig(r, FRAME, still);
    if (!isAwake(r, still)) {
      poseOf(m, r, ahead);
      if (moved(ahead, m.drawn) < 1) {
        copyRig(m.rig, r);
        m.due = Infinity;
        // Asleep, its clock stops here.
        m.at = undefined;
        return;
      }
      m.due = r.t;
      m.recheck = false;
      return;
    }
    poseOf(m, r, ahead);
    if (moved(ahead, m.drawn) >= 1) {
      m.due = r.t;
      m.recheck = false;
      return;
    }
  }
  m.due = r.t;
  m.recheck = true;
};

const pose: number[] = [];
const tick = (now: number): void => {
  frame = undefined;
  if (document.visibilityState !== "visible" || holding()) return stopClocks();
  const still = calm();
  let due = Infinity;
  let draws = false;
  const near: Member[] = [];
  for (const m of members.values()) {
    if (!shown(m) || !isAwake(m.rig, still)) {
      m.at = undefined;
      continue;
    }
    // Its clock moves on by the time since it last did, at most a little past the farthest it sleeps.
    const dt = m.at === undefined ? 0 : Math.min(HORIZON + 0.25, (now - m.at) / 1000);
    m.at = now;
    for (let left = dt; left > 0; left -= 0.05) advanceRig(m.rig, Math.min(0.05, left), still);
    poseOf(m, m.rig, pose);
    const far = moved(pose, m.drawn);
    // A frame comes up to one early (the timer wakes for the frame before it's due): it draws on this one.
    if (far >= 1 || (m.due !== undefined && !m.recheck && m.due - m.rig.t < FRAME)) {
      draw(m);
      draws = true;
    } else if (far >= 0.5) near.push(m);
  }
  // One that's half way there draws on this frame too, rather than wake the window for one of its own soon after.
  if (draws) for (const m of near) draw(m);
  for (const m of members.values()) {
    if (!shown(m) || !isAwake(m.rig, still)) continue;
    // Looked for again once drawn, or once its time has come and the frame found it not far enough yet.
    if (m.due === undefined || m.due <= m.rig.t) lookAhead(m, still);
    if (m.due === undefined || !isAwake(m.rig, still)) continue;
    due = Math.min(due, m.due - m.rig.t);
  }
  if (due < Infinity) schedule(due);
  else stopClocks();
};

/** Wakes the clock for the frame `wait` seconds from now: that frame itself when it's the next, else a timer that
 * sleeps until the frame before it. */
const schedule = (wait: number): void => {
  if (wait <= FRAME * 1.5) frame = requestAnimationFrame(tick);
  else
    timer = window.setTimeout(
      () => {
        timer = undefined;
        frame = requestAnimationFrame(tick);
      },
      (wait - FRAME) * 1000,
    );
};

const stopClocks = (): void => {
  for (const m of members.values()) m.at = undefined;
};

/** Stops the clock, and every bot's, where they are. */
const halt = (): void => {
  if (frame !== undefined) cancelAnimationFrame(frame);
  window.clearTimeout(timer);
  frame = timer = undefined;
  stopClocks();
};

const holding = (): boolean => performance.now() < holdUntil;

/** A key press: the bots hold still until HOLD_MS after it, then wake. */
const onKey = (): void => {
  holdUntil = performance.now() + HOLD_MS;
  halt();
  window.clearTimeout(held);
  held = window.setTimeout(wake, HOLD_MS + 20);
};

/** Runs the clock now if a bot on screen is awake: something changed (a state, a moment, the window). `changed`, a bot
 * whose motion changed, looks ahead again. */
const wake = (changed?: Member): void => {
  if (changed !== undefined) changed.due = undefined;
  if (document.visibilityState !== "visible" || holding()) return;
  const still = calm();
  for (const m of members.values()) {
    if (shown(m) && isAwake(m.rig, still)) {
      window.clearTimeout(timer);
      timer = undefined;
      frame ??= requestAnimationFrame(tick);
      return;
    }
  }
};

/** The window took or lost the focus (an iframe of its own keeps it): without it every bot settles into its still
 * pose, as with reduced motion, and then holds still until it's back. Only a blur says it's gone, never how a page
 * starts: a page opened from the address bar has no focus until it's clicked, and its bots move all the same. */
const onFocus = (): void => {
  const now = document.hasFocus();
  if (now === focused) return;
  focused = now;
  for (const m of members.values()) {
    // Its springs settle, critically damped, well within that; a moment's blink or glance has no part in it.
    if (!now) m.rig.awake = m.rig.t + 0.6;
    m.due = undefined;
  }
  wake();
};
const onBlur = (): void => void window.setTimeout(onFocus, 0);
if (typeof window !== "undefined") {
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
}

/** The next idle list bot's moment, then the rest before the one after. */
const conduct = (): void => {
  conductor = window.setTimeout(conduct, listRest(r) * 1000);
  if (document.visibilityState !== "visible" || calm() || holding()) return;
  const turns = [...members.values()].filter((m) => !m.rig.solo && m.rig.state === "idle" && m !== lastTurn && shown(m));
  const m = turns[Math.floor(r() * turns.length)];
  if (m === undefined) return;
  lastTurn = m;
  moment(m.rig);
  wake(m);
};

const onVisible = (): void => wake();
/** Reduced motion turned on or off: every bot moves by other rules now. */
const onMotion = (): void => {
  for (const m of members.values()) m.due = undefined;
  wake();
};

const start = (): void => {
  if (conductor !== undefined) return;
  if (typeof window.matchMedia === "function") reducedQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  conductor = window.setTimeout(conduct, (0.8 + r()) * 1000);
  document.addEventListener("visibilitychange", onVisible);
  document.addEventListener("keydown", onKey, { capture: true, passive: true });
  reducedQuery?.addEventListener("change", onMotion);
  dark = document.documentElement.dataset["theme"] === "dark";
  themes = new MutationObserver(redraw);
  themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  watchPixels();
};

const stop = (): void => {
  window.clearTimeout(conductor);
  window.clearTimeout(held);
  halt();
  conductor = held = undefined;
  document.removeEventListener("visibilitychange", onVisible);
  document.removeEventListener("keydown", onKey, { capture: true });
  reducedQuery?.removeEventListener("change", onMotion);
  themes?.disconnect();
  pixels?.removeEventListener("change", onPixels);
  themes = pixels = undefined;
};

export interface Living {
  /** Moves it to a new state, blending from where it is. */
  readonly set: (state: BotState) => void;
  /** Paints it in another color, at once. */
  readonly paint: (color: string | undefined) => void;
  readonly release: () => void;
}

/** Brings the bot on `canvas` (Bot.tsx's), in a `box` px box and `color`, to life on `rig`, drawn at once, until it's
 * released. */
export const bringToLife = (canvas: HTMLCanvasElement, rig: Rig, box: number, color?: string): Living => {
  const m: Member = {
    rig,
    canvas,
    // A DOM without canvases (jsdom) has no Path2D either, and its getContext only complains.
    ctx: typeof Path2D === "function" ? canvas.getContext("2d") : null,
    box,
    color,
    // Without an observer, as if always seen.
    seen: typeof IntersectionObserver !== "function",
    drawn: [],
    due: undefined,
    recheck: false,
    ahead: { ...rig },
    at: undefined,
  };
  members.set(canvas, m);
  start();
  draw(m);
  const seeing =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          for (const e of entries) m.seen = e.isIntersecting;
          wake();
        })
      : undefined;
  seeing?.observe(canvas);
  // A live one moves from its first frame on (an observer's first word, that it's seen, comes after).
  wake(m);
  return {
    set: (state) => {
      setRigState(rig, state, calm());
      wake(m);
    },
    paint: (next) => {
      m.color = next;
      draw(m);
    },
    release: () => {
      seeing?.disconnect();
      members.delete(canvas);
      if (lastTurn === m) lastTurn = undefined;
      if (members.size === 0) stop();
    },
  };
};
