// What keeps the bots alive on the desktop (shared/bot.ts): one requestAnimationFrame loop steps every bot that is
// awake and on screen and writes its frame, and stops when none is; and one conductor gives an idle bot in a list its
// moment (a blink or a glance) every 1.6 to 3.6 s, never the same one twice running, so idle rows take turns. A bot in
// a live state (thinking, working, needs you, done, an error) keeps moving while it's on screen. The bots are the one
// exception to the app's 120 ms motion beat (D377): springs at the display's rate, and only while they are seen.
// Nothing moves while the window is hidden or for a bot off screen, whose clock stops there; with reduced motion a
// change settles in about 150 ms and then the bot is still. While you type they hold still too, until HOLD_MS after the
// last key: a frame drawn for them each display frame cost each key press a frame or two on its way to the screen
// (`pnpm perf`'s keypress p95 went from 4 to 35 ms), and their clocks stop, so they go on from where they were.
import { advanceRig, frameOf, isAwake, listRest, matrixAttr, moment, random, setRigState, type BotState, type Rig } from "../../../shared/bot";

interface Member {
  readonly rig: Rig;
  readonly svg: SVGSVGElement;
  readonly body: Element | null;
  readonly shadow: Element | null;
  readonly sheen: Element | null;
  readonly eyes: readonly Element[];
  readonly glow: Element | null;
  readonly glows: readonly Element[];
  seen: boolean;
}

let reducedQuery: MediaQueryList | undefined;
const calm = (): boolean => reducedQuery?.matches === true;

const members = new Map<SVGSVGElement, Member>();
const r = random(Math.floor(Math.random() * 2 ** 31));
let conductor: number | undefined;
let frame: number | undefined;
let last: number | undefined;
let lastTurn: Member | undefined;
/** How long the bots hold still after a key press. */
const HOLD_MS = 1200;
let holdUntil = 0;
let held: number | undefined;

/** Writes `m`'s frame into its SVG. */
const draw = (m: Member): void => {
  const f = frameOf(m.rig);
  m.body?.setAttribute("transform", matrixAttr(f.body));
  m.shadow?.setAttribute("transform", matrixAttr(f.shadow));
  m.shadow?.setAttribute("opacity", String(Math.round(f.shadowOpacity * 1000) / 1000));
  m.sheen?.setAttribute("transform", matrixAttr(f.sheen));
  m.eyes[0]?.setAttribute("d", f.eyes[0]);
  m.eyes[1]?.setAttribute("d", f.eyes[1]);
  m.svg.style.setProperty("--dim", String(Math.round(f.dim * 1000) / 1000));
  if (m.glow !== null) {
    m.svg.style.setProperty("--glow", String(Math.round(f.glow * 1000) / 1000));
    m.glows[0]?.setAttribute("d", f.eyes[0]);
    m.glows[1]?.setAttribute("d", f.eyes[1]);
  }
};

const shown = (m: Member): boolean => m.seen && m.svg.isConnected;

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
};

const stop = (): void => {
  window.clearTimeout(conductor);
  window.clearTimeout(held);
  if (frame !== undefined) cancelAnimationFrame(frame);
  conductor = frame = last = held = undefined;
  document.removeEventListener("visibilitychange", onVisible);
  document.removeEventListener("keydown", onKey, { capture: true });
  reducedQuery?.removeEventListener("change", onVisible);
};

export interface Living {
  /** Moves it to a new state, blending from where it is. */
  readonly set: (state: BotState) => void;
  readonly release: () => void;
}

/** Brings the bot drawn in `svg` (Bot.tsx's parts, by data-part) to life on `rig`, until it's released. */
export const bringToLife = (svg: SVGSVGElement, rig: Rig): Living => {
  const part = (name: string) => svg.querySelector(`[data-part="${name}"]`);
  const glow = part("glow");
  const m: Member = {
    rig,
    svg,
    body: part("body"),
    shadow: part("shadow"),
    sheen: part("sheen"),
    eyes: [...(part("eyes")?.children ?? [])],
    glow,
    glows: [...(glow?.children ?? [])],
    // Without an observer, as if always seen.
    seen: typeof IntersectionObserver !== "function",
  };
  members.set(svg, m);
  start();
  const seeing =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          for (const e of entries) m.seen = e.isIntersecting;
          wake();
        })
      : undefined;
  seeing?.observe(svg);
  return {
    set: (state) => {
      setRigState(rig, state, calm());
      wake();
    },
    release: () => {
      seeing?.disconnect();
      members.delete(svg);
      if (lastTurn === m) lastTurn = undefined;
      if (members.size === 0) stop();
    },
  };
};
