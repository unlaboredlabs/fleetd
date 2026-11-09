// What keeps the bots alive on the desktop (shared/bot.ts): one requestAnimationFrame loop steps every bot that is
// awake and on screen and draws its frame, and stops when none is; and one conductor gives an idle bot in a list its
// moment (a blink or a glance) every 1.6 to 3.6 s, never the same one twice running, so idle rows take turns. A bot in
// a live state (thinking, working, needs you, done, an error) keeps moving while it's on screen. The bots are the one
// exception to the app's 120 ms motion beat (D377): springs at the display's rate, and only while they are seen.
// Nothing moves while the window is hidden or for a bot off screen, whose clock stops there; with reduced motion a
// change settles in about 150 ms and then the bot is still. While you type they hold still too, until HOLD_MS after the
// last key: a frame drawn for them each display frame cost each key press a frame or two on its way to the screen
// (`pnpm perf`'s keypress p95 went from 4 to 35 ms), and their clocks stop, so they go on from where they were.
//
// A bot is drawn on its own canvas, its eyes traced straight from the rig's numbers (traceEyes), so a frame makes no
// strings and touches no DOM. Drawn as an SVG, each frame's new transform and paths left the renderer style and paint
// garbage that only a major GC frees: three bots in live states held 60 MB more of it after 10 s idle (`pnpm perf`'s
// idle memory went from 347 to 412 MB), and writing only what changed didn't lower that, only how soon it got there.
import { advanceRig, BODY, bodyOf, CROP, dimOf, DIMMED, glowOf, isAwake, listRest, moment, PEBBLE, random, setRigState, traceEyes, type BotState, type Rig } from "../../../shared/bot";

interface Member {
  readonly rig: Rig;
  readonly canvas: HTMLCanvasElement;
  /** None where there's no canvas to draw on (a test's DOM). */
  readonly ctx: CanvasRenderingContext2D | null;
  /** Its box's side, in CSS px. */
  readonly box: number;
  seen: boolean;
}

/** How far the canvas reaches past each side of the box, of its side, so a hop or a slump is never cut off
 * (Bot.module.css's .canvas). */
export const PAD = 0.25;
/** The eyes' glow: their blur's standard deviation, in the body's units. */
const GLOW_BLUR = 2.4;

let reducedQuery: MediaQueryList | undefined;
const calm = (): boolean => reducedQuery?.matches === true;

const members = new Map<HTMLCanvasElement, Member>();
const r = random(Math.floor(Math.random() * 2 ** 31));
let conductor: number | undefined;
let frame: number | undefined;
let last: number | undefined;
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

/** Draws `m`'s frame on its canvas, in the theme's paint and at the display's pixel ratio. */
const draw = (m: Member): void => {
  const c = m.ctx;
  if (c === null) return;
  const px = Math.round(m.box * (1 + 2 * PAD) * (window.devicePixelRatio || 1));
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
  const paint = dark ? PEBBLE.dark : PEBBLE.light;
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

const tick = (now: number): void => {
  frame = undefined;
  if (document.visibilityState !== "visible" || holding()) return void (last = undefined);
  const dt = last === undefined ? 0 : (now - last) / 1000;
  last = now;
  const still = calm();
  let moving = false;
  for (const m of members.values()) {
    if (!shown(m) || !isAwake(m.rig, still)) continue;
    advanceRig(m.rig, dt, still);
    draw(m);
    moving = true;
  }
  if (moving) frame = requestAnimationFrame(tick);
  else last = undefined;
};

const holding = (): boolean => performance.now() < holdUntil;

/** A key press: the bots hold still until HOLD_MS after it, then wake. */
const onKey = (): void => {
  holdUntil = performance.now() + HOLD_MS;
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = last = undefined;
  window.clearTimeout(held);
  held = window.setTimeout(wake, HOLD_MS + 20);
};

/** Runs the loop if a bot on screen is awake. */
const wake = (): void => {
  if (frame !== undefined || document.visibilityState !== "visible" || holding()) return;
  const still = calm();
  for (const m of members.values()) {
    if (shown(m) && isAwake(m.rig, still)) {
      frame = requestAnimationFrame(tick);
      return;
    }
  }
};

/** The next idle list bot's moment, then the rest before the one after. */
const conduct = (): void => {
  conductor = window.setTimeout(conduct, listRest(r) * 1000);
  if (document.visibilityState !== "visible" || calm() || holding()) return;
  const turns = [...members.values()].filter((m) => !m.rig.solo && m.rig.state === "idle" && m !== lastTurn && shown(m));
  const m = turns[Math.floor(r() * turns.length)];
  if (m === undefined) return;
  lastTurn = m;
  moment(m.rig);
  wake();
};

const onVisible = (): void => wake();

const start = (): void => {
  if (conductor !== undefined) return;
  if (typeof window.matchMedia === "function") reducedQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  conductor = window.setTimeout(conduct, (0.8 + r()) * 1000);
  document.addEventListener("visibilitychange", onVisible);
  document.addEventListener("keydown", onKey, { capture: true, passive: true });
  reducedQuery?.addEventListener("change", onVisible);
  dark = document.documentElement.dataset["theme"] === "dark";
  themes = new MutationObserver(redraw);
  themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  watchPixels();
};

const stop = (): void => {
  window.clearTimeout(conductor);
  window.clearTimeout(held);
  if (frame !== undefined) cancelAnimationFrame(frame);
  conductor = frame = last = held = undefined;
  document.removeEventListener("visibilitychange", onVisible);
  document.removeEventListener("keydown", onKey, { capture: true });
  reducedQuery?.removeEventListener("change", onVisible);
  themes?.disconnect();
  pixels?.removeEventListener("change", onPixels);
  themes = pixels = undefined;
};

export interface Living {
  /** Moves it to a new state, blending from where it is. */
  readonly set: (state: BotState) => void;
  readonly release: () => void;
}

/** Brings the bot on `canvas` (Bot.tsx's), in a `box` px box, to life on `rig`, drawn at once, until it's released. */
export const bringToLife = (canvas: HTMLCanvasElement, rig: Rig, box: number): Living => {
  const m: Member = {
    rig,
    canvas,
    // A DOM without canvases (jsdom) has no Path2D either, and its getContext only complains.
    ctx: typeof Path2D === "function" ? canvas.getContext("2d") : null,
    box,
    // Without an observer, as if always seen.
    seen: typeof IntersectionObserver !== "function",
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
  return {
    set: (state) => {
      setRigState(rig, state, calm());
      wake();
    },
    release: () => {
      seeing?.disconnect();
      members.delete(canvas);
      if (lastTurn === m) lastTurn = undefined;
      if (members.size === 0) stop();
    },
  };
};
