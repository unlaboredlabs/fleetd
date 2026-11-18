// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { advanceRig, bodyOf, drawnAt, newRig, traceEyes, type BotState, type Rig } from "../../../shared/bot";
import { bringToLife, type Living } from "./botLife";

// A canvas that keeps what each frame drew: a draw begins the eyes' path once, after the body's matrix.
let draws = 0;
let frames = 0;
let matrix: number[] = [];
let eyes: number[] = [];
const shown: { matrix: number[]; eyes: number[] }[] = [];
const ctx = new Proxy(
  {},
  {
    get: (_t, k) => {
      if (k === "beginPath") return () => (draws++, (eyes = []), shown.push({ matrix, eyes }));
      if (k === "transform") return (...m: number[]) => void (matrix = m);
      if (k === "moveTo") return (x: number, y: number) => void eyes.push(x, y);
      if (k === "bezierCurveTo") return (...p: number[]) => void eyes.push(p[4] ?? 0, p[5] ?? 0);
      return () => undefined;
    },
    set: () => true,
  },
);

let lives: Living[] = [];
let focus = true;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  vi.stubGlobal("Path2D", vi.fn());
  // Every bot on screen, as with no observer.
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
  focus = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focus);
  const raf = window.requestAnimationFrame.bind(window);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => raf((t) => (frames++, cb(t))));
  draws = frames = 0;
  shown.length = 0;
});
afterEach(() => {
  for (const l of lives) l.release();
  lives = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const seedOf = (n: number) => n * 7919 + 1;
const bot = (state: BotState, box = 40): Living => {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const l = bringToLife(canvas, newRig(state, drawnAt(box), seedOf(lives.length), false), box);
  lives.push(l);
  return l;
};

/** The sidebar at rest as `pnpm perf` and the desktop report measured it: four bots at work, four idle, and the chat's. */
const sidebar = () => {
  for (const s of ["working", "working", "working", "working", "idle", "idle", "idle", "idle"] as const) bot(s);
  bot("working", 24);
};

it("draws a bot only when it has moved, and its frames on a shared, slower clock: not every display frame", () => {
  sidebar();
  vi.advanceTimersByTime(2000);
  draws = frames = 0;
  vi.advanceTimersByTime(10_000);
  // Every display frame, every bot drawn, was 62 frames and 356 draws a second.
  expect(frames / 10).toBeLessThan(40);
  expect(draws / 10).toBeLessThan(100);
  // And still alive: the working bots read, the idle ones take their turns.
  expect(draws / 10).toBeGreaterThan(20);
});

/** The rig's eye outline and the body's matrix, in device px for a 40 px box at a pixel ratio of 1. */
const K = 60 / 120;
const devicePx = (m: readonly number[], pts: readonly number[]): number[] => {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i] ?? 0;
    const y = pts[i + 1] ?? 0;
    out.push(K * (a * x + c * y + e), K * (b * x + d * y + f));
  }
  return out;
};
const truth = (r: Rig): number[] => {
  const pts: number[] = [];
  traceEyes(r, { moveTo: (x, y) => void pts.push(x, y), bezierCurveTo: (_a, _b, _c, _d, x, y) => void pts.push(x, y), closePath: () => undefined }, []);
  return devicePx(bodyOf(r), pts);
};

it.each(["working", "thinking", "needs", "done", "error"] as const)("shows a %s bot within a pixel of where it would be drawn every frame", (state) => {
  bot(state);
  // The same bot, stepped every display frame from the first one on.
  const ref = newRig(state, drawnAt(40), seedOf(0), false);
  vi.advanceTimersByTime(16);
  let most = 0;
  for (let f = 0; f < 60 * 8; f++) {
    vi.advanceTimersByTime(16);
    advanceRig(ref, 0.016, false);
    const last = shown.at(-1);
    if (last === undefined) continue;
    const now = devicePx(last.matrix, last.eyes);
    const want = truth(ref);
    for (let i = 0; i < want.length; i++) most = Math.max(most, Math.abs((now[i] ?? 0) - (want[i] ?? 0)));
  }
  expect(most).toBeLessThan(1);
});

it("settles and holds still while the window isn't focused, and moves again once it is", () => {
  sidebar();
  vi.advanceTimersByTime(2000);
  focus = false;
  window.dispatchEvent(new FocusEvent("blur"));
  vi.advanceTimersByTime(1000);
  draws = frames = 0;
  vi.advanceTimersByTime(5000);
  expect(frames).toBe(0);
  expect(draws).toBe(0);
  focus = true;
  window.dispatchEvent(new FocusEvent("focus"));
  vi.advanceTimersByTime(3000);
  expect(draws).toBeGreaterThan(10);
});

it("still draws a change of state at once, blending from where it is", () => {
  const l = bot("idle");
  vi.advanceTimersByTime(4000);
  draws = 0;
  l.set("needs");
  vi.advanceTimersByTime(34);
  expect(draws).toBeGreaterThan(0);
  vi.advanceTimersByTime(600);
  // The hop's frames come at the list's clock at most, half the display's rate.
  expect(draws).toBeGreaterThan(8);
});
