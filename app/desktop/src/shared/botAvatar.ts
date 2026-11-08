// The built-in avatar a project or Navi wears, on the desktop and the phone alike (app/mobile/src/ui/Being.tsx): Ink,
// a soft-black being with light eyes on a pale tint of its color, drawn as vector shapes and gently alive. The hub
// names each one's face and color (IconFace, IconColor in fleetd-contracts, which its icon_tests keep in step with
// this file) and derives one from a project's id until a person picks.
//
// It is all here, pure, so both apps draw and move it alike:
// - the drawing, in a 100×100 box: the shared hand-tuned body, each face's parts, and its colors light and dark;
// - its pose: given the motion's state (a blink, the eyes' look, the body's lean, the breath), each moving part's
//   transform as an SVG matrix, which the desktop writes as an attribute and the phone hands react-native-svg;
// - its motion: damped springs (mass 1, the stiffness and damping Reanimated's withSpring takes), summed exactly, so a
//   move started mid-flight carries its speed; nothing tweens and nothing loops;
// - what it does idle: in a list one avatar at a time has a moment (a blink, a glance, a double blink); a large one
//   lives on its own, blinking every few seconds, glancing now and then, and breathing slowly and unevenly.
// The functions the phone runs on its UI thread are worklets ("worklet"), a plain string to the desktop.
import type { IconColor, IconFace } from "./contracts";

/** A face's part, in the box: an open eye, a lid's crescent (shut, bowing down for a doze, up for a smile), an eye
 * shut flat above a line, or a mouth. Eyes and lidded eyes blink; crescents and mouths only move with the face. */
export type Part =
  | { readonly kind: "eye"; readonly x: number; readonly y: number; readonly rx: number; readonly ry: number; readonly tilt: number }
  | { readonly kind: "lid"; readonly x1: number; readonly x2: number; readonly y: number; readonly depth: number; readonly thick: number }
  | { readonly kind: "lidded"; readonly x: number; readonly y: number; readonly rx: number; readonly ry: number; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
  | { readonly kind: "mouth"; readonly x: number; readonly y: number; readonly rx: number; readonly ry: number };

const eye = (x: number, y: number, rx: number, ry: number, tilt: number): Part => ({ kind: "eye", x, y, rx, ry, tilt });
const lid = (x1: number, x2: number, y: number, depth: number, thick: number): Part => ({ kind: "lid", x1, x2, y, depth, thick });

/** The shared silhouette, as cubic Béziers. */
export const BODY = "M50 25C67.4 25 79 37 79 55C79 71.8 70.3 79 50 79C29.7 79 21 71.8 21 55C21 37 32.6 25 50 25Z";

/** The faces, each named for its mood's look, in the hub's order. */
export const ICON_FACES: readonly { readonly id: IconFace; readonly name: string; readonly parts: readonly Part[] }[] = [
  { id: "mo", name: "Mo", parts: [eye(40, 50, 4.8, 6.3, -6), eye(60, 50, 4.8, 6.3, 6)] },
  { id: "wee", name: "Wee", parts: [eye(45, 59, 3.8, 4.9, -4), eye(55, 59, 3.8, 4.9, 4)] },
  { id: "peep", name: "Peep", parts: [eye(56, 45, 4.9, 6.5, 4), eye(69.5, 45.5, 4.3, 5.7, 8)] },
  { id: "nap", name: "Nap", parts: [lid(32, 46, 50, 7, 5.4), lid(54, 68, 50, 7, 5.4)] },
  { id: "cy", name: "Cy", parts: [eye(53, 46, 7.4, 9.2, 4)] },
  { id: "wink", name: "Wink", parts: [eye(40, 50, 4.8, 6.3, -6), lid(53, 68, 55, -10, 5.4)] },
  { id: "joy", name: "Joy", parts: [lid(31, 46, 56, -11, 5.4), lid(54, 69, 56, -11, 5.4)] },
  { id: "huh", name: "Huh", parts: [eye(40, 50, 4.8, 6.3, -6), { kind: "lidded", x: 60, y: 51, rx: 5.2, ry: 6.3, x1: 52, y1: 48.5, x2: 68, y2: 50.5 }] },
  { id: "wow", name: "Wow", parts: [eye(38, 47, 5.6, 6.5, -4), eye(62, 47, 5.6, 6.5, 4), { kind: "mouth", x: 50, y: 64, rx: 3.2, ry: 4 }] },
];

/** The colors, in the hub's order: each a hue (OKLCH degrees) and how much of the calm chroma it carries. */
export const ICON_COLORS: readonly { readonly id: IconColor; readonly name: string; readonly hue: number; readonly chroma: number }[] = [
  { id: "fleet", name: "Fleet", hue: 258, chroma: 1 },
  { id: "sky", name: "Sky", hue: 232, chroma: 0.9 },
  { id: "teal", name: "Teal", hue: 195, chroma: 0.85 },
  { id: "mint", name: "Mint", hue: 162, chroma: 0.85 },
  { id: "lime", name: "Sage", hue: 128, chroma: 0.8 },
  { id: "sun", name: "Butter", hue: 92, chroma: 1.05 },
  { id: "ember", name: "Clay", hue: 45, chroma: 1 },
  { id: "rose", name: "Rose", hue: 8, chroma: 0.95 },
  { id: "plum", name: "Plum", hue: 305, chroma: 0.95 },
  { id: "lilac", name: "Lilac", hue: 290, chroma: 0.85 },
  { id: "sand", name: "Sand", hue: 75, chroma: 0.6 },
  { id: "graphite", name: "Graphite", hue: 250, chroma: 0.08 },
];

/** A face this build doesn't know draws as Mo, a color as Graphite. */
export const faceOf = (id: IconFace): readonly Part[] => (ICON_FACES.find((f) => f.id === id) ?? ICON_FACES[0])?.parts ?? [];
const colorOf = (id: IconColor) => ICON_COLORS.find((c) => c.id === id) ?? { hue: 250, chroma: 0.08 };

/** OKLCH to "#rrggbb". */
export const oklch = (l: number, c: number, h: number): string => {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3, -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3, -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3];
  const byte = (x: number) => {
    const v = Math.max(0, Math.min(1, x));
    return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  };
  return `#${lin.map((x) => byte(x).toString(16).padStart(2, "0")).join("")}`;
};

/** What an avatar of a color is painted with. */
export interface Colors {
  /** The round ground the being stands on: the project's color, pale. */
  readonly field: string;
  /** The being, lit from its top left: its body, lightest to darkest. */
  readonly bodyHi: string;
  readonly body: string;
  readonly bodyLo: string;
  /** A soft sheen on its crown. */
  readonly hi: string;
  readonly hiA: number;
  /** Its shadow on the ground. */
  readonly shadow: string;
  readonly shadowA: number;
  /** Its eyes, lids and mouth. */
  readonly eye: string;
}

const painted = new Map<string, Colors>();

/** The colors of `id`, light or dark. In dark the ground is a deeper, slightly richer tint, so it stays a color on a
 * black screen, and the being a touch blacker with a brighter sheen, so it still stands off its ground. */
export const colorsOf = (id: IconColor, dark: boolean): Colors => {
  const key = `${id}:${dark ? "d" : "l"}`;
  const known = painted.get(key);
  if (known !== undefined) return known;
  const { hue: h, chroma: c } = colorOf(id);
  const made: Colors = dark
    ? {
        field: oklch(0.54, 0.06 * c, h),
        bodyHi: oklch(0.27, 0.012 * c, h),
        body: oklch(0.17, 0.008 * c, h),
        bodyLo: oklch(0.15, 0.006 * c, h),
        hi: oklch(0.84, 0.03 * c, h),
        hiA: 0.28,
        shadow: oklch(0.1, 0.01, h),
        shadowA: 0.5,
        eye: oklch(0.97, 0.012 * c, h),
      }
    : {
        field: oklch(0.9, 0.048 * c, h),
        bodyHi: oklch(0.31, 0.014 * c, h),
        body: oklch(0.22, 0.01 * c, h),
        bodyLo: oklch(0.2, 0.008 * c, h),
        hi: oklch(0.8, 0.03 * c, h),
        hiA: 0.22,
        shadow: oklch(0.55, 0.06 * c, h),
        shadowA: 0.35,
        eye: oklch(0.985, 0.008 * c, h),
      };
  painted.set(key, made);
  return made;
};

/** Where the being stands in its circle: scaled about the box's origin, then moved. */
export const PLACE = { scale: 1.16, x: -8, y: -9 } as const;
/** The body's light: a radial gradient's centre and radius, and where its middle stop sits. */
export const LIGHT = { cx: 38, cy: 26, r: 50, mid: 0.45 } as const;
/** The sheen on its crown and its shadow on the ground, as ellipses [x, y, rx, ry] (the sheen tilted by its degrees). */
export const SHEEN = { x: 36, y: 33, rx: 9, ry: 3.6, tilt: -30 } as const;
export const SHADOW = { x: 50, y: 79.2, rx: 24.5, ry: 3 } as const;
/** Ink's eyes are a touch smaller than the beings' own. */
const EYE_SCALE = 0.94;

/** A part drawn about its own centre, which its pose moves. */
export interface Drawn {
  readonly x: number;
  readonly y: number;
  /** An ellipse [rx, ry, tilt°], or a path. */
  readonly ellipse?: readonly [number, number, number];
  readonly path?: string;
  /** Its blink squashes it toward this far below its centre, or it doesn't blink. */
  readonly blink?: number;
}

const n = (v: number) => Math.round(v * 100) / 100;

/** A lid's crescent: two quadratic curves between its ends, the outer bowing `depth`, the inner `thick` short of it. */
const crescent = (p: Extract<Part, { kind: "lid" }>): Drawn => {
  const m = (p.x1 + p.x2) / 2;
  const half = (p.x2 - p.x1) / 2;
  const inner = p.depth > 0 ? p.depth - 2 * p.thick : p.depth + 2 * p.thick;
  // About the crescent's middle, half its depth and inner bow below the line.
  const cy = (p.depth + inner) / 4;
  return { x: m, y: p.y + cy, path: `M${n(-half)} ${n(-cy)}Q0 ${n(p.depth - cy)} ${n(half)} ${n(-cy)}Q0 ${n(inner - cy)} ${n(-half)} ${n(-cy)}Z` };
};

/** An eye shut flat from above: the part of its ellipse below the line from (x1, y1) to (x2, y2). */
const lidded = (p: Extract<Part, { kind: "lidded" }>): Drawn => {
  const rx = p.rx * EYE_SCALE;
  const ry = p.ry * EYE_SCALE;
  // Where the line crosses the ellipse: x = x1 + s·dx, y = y1 + s·dy into ((x - cx)/rx)² + ((y - cy)/ry)² = 1.
  const dx = p.x2 - p.x1;
  const dy = p.y2 - p.y1;
  const ox = p.x1 - p.x;
  const oy = p.y1 - p.y;
  const a = (dx / rx) ** 2 + (dy / ry) ** 2;
  const b = 2 * ((ox * dx) / rx ** 2 + (oy * dy) / ry ** 2);
  const c = (ox / rx) ** 2 + (oy / ry) ** 2 - 1;
  const root = Math.sqrt(Math.max(0, b * b - 4 * a * c));
  const at = (s: number) => [ox + s * dx, oy + s * dy] as const;
  const [ax, ay] = at((-b - root) / (2 * a));
  const [bx, by] = at((-b + root) / (2 * a));
  // From its left end round the bottom to its right: the larger arc, counter-clockwise on screen.
  return { x: p.x, y: p.y, path: `M${n(ax)} ${n(ay)}A${n(rx)} ${n(ry)} 0 1 0 ${n(bx)} ${n(by)}Z`, blink: ry * 0.3 };
};

/** Each part of `face` as it is drawn. */
export const drawnFace = (face: IconFace): readonly Drawn[] =>
  faceOf(face).map((p): Drawn => {
    switch (p.kind) {
      case "eye":
        return { x: p.x, y: p.y, ellipse: [p.rx * EYE_SCALE, p.ry * EYE_SCALE, p.tilt], blink: p.ry * EYE_SCALE * 0.3 };
      case "mouth":
        return { x: p.x, y: p.y, ellipse: [p.rx, p.ry, 0] };
      case "lid":
        return crescent(p);
      case "lidded":
        return lidded(p);
    }
  });

/** Whether any of `face`'s parts blinks: Nap's and Joy's are shut, so their moments are glances. */
export const blinks = (face: IconFace): boolean => drawnFace(face).some((d) => d.blink !== undefined);

// ---- Pose

/** An SVG matrix [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = readonly [number, number, number, number, number, number];

const mul = (p: Matrix, q: Matrix): Matrix => {
  "worklet";
  return [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3], p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]];
};
const move = (x: number, y: number): Matrix => {
  "worklet";
  return [1, 0, 0, 1, x, y];
};
const scale = (x: number, y: number): Matrix => {
  "worklet";
  return [x, 0, 0, y, 0, 0];
};
const turn = (deg: number): Matrix => {
  "worklet";
  const r = (deg * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
};

/** The motion's state at a moment: a blink 0 (open) to 1 (shut), the look (about -1 to 1 each way), the body's lean
 * after it, and the breath (about -1 to 1). */
export type Motion = readonly [blink: number, gx: number, gy: number, lean: number, breath: number];
export const STILL: Motion = [0, 0, 0, 0, 0];

/** How far each part of the motion goes: the eyes' look in the box's units, the lean's tilt in degrees and slide. */
const GAZE = { x: 3.4, y: 2.2 } as const;
const LEAN = { deg: 2.8, x: 0.9 } as const;

/** Every moving part's matrix: the being (body and face), its shadow, its sheen, then each face part's place and its
 * blink, two by two. `parts` is drawnFace's [x, y, blink] flattened (blink -1 for none), so a worklet takes it as is. */
export const pose = (parts: readonly number[], m: Motion): Matrix[] => {
  "worklet";
  const [blink, gx, gy, lean, br] = m;
  const lx = lean * LEAN.x;
  const at = move(50, 79);
  const being = mul(mul(mul(move(lx, 0), mul(at, mul(turn(lean * LEAN.deg), move(-50, -79)))), at), mul(scale(1 - 0.006 * br, 1 + 0.014 * br), move(-50, -79)));
  const shs = 1 + 0.01 * br;
  const out: Matrix[] = [being, mul(move(SHADOW.x + lx * 0.6, SHADOW.y), scale(SHADOW.rx * shs, SHADOW.ry * shs)), mul(move(-gx * 0.45, 0), mul(move(SHEEN.x, SHEEN.y), mul(turn(SHEEN.tilt), scale(SHEEN.rx, SHEEN.ry))))];
  const count = parts.length / 3;
  let fx = 0;
  for (let i = 0; i < count; i++) fx += parts[i * 3] ?? 0;
  fx /= Math.max(1, count);
  // A head turn, cheaply: the face slides toward the look and narrows a little, as on a ball turning.
  const t = Math.min(1, Math.abs(gx));
  const k = Math.max(0.07, 1 - 0.93 * blink);
  for (let i = 0; i < count; i++) {
    const x = parts[i * 3] ?? 0;
    const y = parts[i * 3 + 1] ?? 0;
    const o = parts[i * 3 + 2] ?? -1;
    out.push(mul(move(fx + (x - fx) * (1 - 0.1 * t) + gx * GAZE.x, y + gy * GAZE.y - br * 0.35), scale(1 - 0.08 * t, 1)));
    // The upper lid comes down: a squash toward a line a little below the eye's middle.
    out.push(o < 0 ? [1, 0, 0, 1, 0, 0] : [1, 0, 0, k, 0, o * (1 - k)]);
  }
  return out;
};

/** drawnFace as pose takes it. */
export const poseParts = (drawn: readonly Drawn[]): number[] => drawn.flatMap((d) => [d.x, d.y, d.blink ?? -1]);

/** "matrix(a b c d e f)", for an SVG attribute. */
export const matrixAttr = (m: Matrix): string => `matrix(${m.map((v) => String(Math.round(v * 10000) / 10000)).join(" ")})`;

// ---- Springs

/** A spring, mass 1: Reanimated's withSpring({ stiffness, damping, mass: 1 }). */
export interface Spring {
  readonly stiffness: number;
  readonly damping: number;
}

/** The motion's springs, one per move. */
export const SPRINGS = {
  /** A lid closes in about 70 ms, with no bounce, and opens in about 170, a hair soft. */
  lidClose: { stiffness: 1500, damping: 66 },
  lidOpen: { stiffness: 560, damping: 40 },
  /** The eyes go quickly, about 2% over, and drift home easily. */
  gazeGo: { stiffness: 260, damping: 25 },
  gazeBack: { stiffness: 110, damping: 18 },
  /** The body follows the eyes, late and soft. */
  lean: { stiffness: 70, damping: 12 },
  /** A breath, about 2.5 s each way. */
  breath: { stiffness: 5.5, damping: 4.2 },
} as const satisfies Record<string, Spring>;

/** A spring's unit step response τ seconds after it starts: 0 at its start, settling at 1. */
export const step = (stiffness: number, damping: number, tau: number): number => {
  "worklet";
  const w0 = Math.sqrt(stiffness);
  const z = damping / (2 * w0);
  if (z < 1) {
    const wd = w0 * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w0 * tau) * (Math.cos(wd * tau) + ((z * w0) / wd) * Math.sin(wd * tau));
  }
  if (z === 1) return 1 - Math.exp(-w0 * tau) * (1 + w0 * tau);
  const r = Math.sqrt(z * z - 1);
  const r1 = -w0 * (z - r);
  const r2 = -w0 * (z + r);
  return 1 - (r2 * Math.exp(r1 * tau) - r1 * Math.exp(r2 * tau)) / (r2 - r1);
};

/** How long a spring takes to come to rest, near enough. */
export const settles = ({ stiffness, damping }: Spring): number => {
  const w0 = Math.sqrt(stiffness);
  const z = damping / (2 * w0);
  return 7 / (z < 1 ? z * w0 : w0 * (z - Math.sqrt(z * z - 1)));
};

/** The channels of Motion, in its order. */
export const BLINK = 0;
export const GX = 1;
export const GY = 2;
export const LEAN_CH = 3;
export const BREATH = 4;

/** A move: on channel `ch`, from `t` (seconds), by `d`, on a spring. Flattened five numbers to a move, with each
 * channel's settled sum ahead of them, so a worklet reads it as is: [base × 5, (ch, t, d, stiffness, damping) × n]. */
export type Moves = readonly number[];

/** The motion's state at `t` from its moves: each channel's settled base plus every move's spring so far. */
export const motionAt = (moves: Moves, t: number): Motion => {
  "worklet";
  const v = [moves[0] ?? 0, moves[1] ?? 0, moves[2] ?? 0, moves[3] ?? 0, moves[4] ?? 0];
  for (let i = 5; i + 4 < moves.length; i += 5) {
    const tau = t - (moves[i + 1] ?? 0);
    if (tau <= 0) continue;
    const ch = moves[i] ?? 0;
    v[ch] = (v[ch] ?? 0) + (moves[i + 2] ?? 0) * step(moves[i + 3] ?? 1, moves[i + 4] ?? 1, tau);
  }
  return [Math.max(0, Math.min(1, v[0] ?? 0)), v[1] ?? 0, v[2] ?? 0, v[3] ?? 0, v[4] ?? 0];
};

/** One avatar's moves as they are planned: moves that have settled fold into their channel's base. */
export class Plan {
  private readonly base = [0, 0, 0, 0, 0];
  private moves: { ch: number; t: number; d: number; s: Spring; done: number }[] = [];

  add(ch: number, t: number, d: number, s: Spring): void {
    this.moves.push({ ch, t, d, s, done: t + settles(s) });
  }

  /** Drops what has settled by `now` into the bases. */
  settle(now: number): void {
    const left: typeof this.moves = [];
    for (const m of this.moves) {
      if (m.done <= now) this.base[m.ch] = (this.base[m.ch] ?? 0) + m.d;
      else left.push(m);
    }
    this.moves = left;
  }

  /** When the last move comes to rest: until then the avatar draws frames. */
  get until(): number {
    return this.moves.reduce((a, m) => Math.max(a, m.done), -Infinity);
  }

  get flat(): Moves {
    return [...this.base, ...this.moves.flatMap((m) => [m.ch, m.t, m.d, m.s.stiffness, m.s.damping])];
  }

  /** A blink: the lid closes and opens 75 ms after, before it has quite shut; now and then twice. */
  blink(t: number, twice = false): void {
    this.add(BLINK, t, 1, SPRINGS.lidClose);
    this.add(BLINK, t + 0.075, -1, SPRINGS.lidOpen);
    if (twice) {
      this.add(BLINK, t + 0.29, 1, SPRINGS.lidClose);
      this.add(BLINK, t + 0.365, -1, SPRINGS.lidOpen);
    }
  }

  /** A glance: the eyes go first and the body leans after them, held, then home; a blink on the way out if asked. */
  glance(t: number, dx: number, dy: number, hold: number, blinkOut: boolean, lean: number): void {
    if (blinkOut) this.blink(t - 0.03);
    this.add(GX, t, dx, SPRINGS.gazeGo);
    this.add(GY, t, dy, SPRINGS.gazeGo);
    this.add(LEAN_CH, t + 0.06, dx * lean, SPRINGS.lean);
    this.add(GX, t + hold, -dx, SPRINGS.gazeBack);
    this.add(GY, t + hold, -dy, SPRINGS.gazeBack);
    this.add(LEAN_CH, t + hold + 0.04, -dx * lean, SPRINGS.lean);
  }
}

/** A seeded random in [0, 1) (mulberry32). */
export const random = (seed: number): (() => number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** At what size an avatar lives on its own (a chat's or project's screen), rather than taking turns in a list. */
export const LARGE = 80;

/** In a list, the rest between one avatar's moment and the next one's, in seconds: 2.2 to 4.8. */
export const listRest = (r: () => number): number => 2.2 + r() * 2.6;

/** A list avatar's moment at `t`: a blink (55%), a glance (35%), or two blinks a second apart; a face that can't
 * blink always glances, without one. */
export const listMoment = (plan: Plan, r: () => number, t: number, canBlink: boolean): void => {
  const p = canBlink ? r() : 0.6;
  if (p < 0.55) plan.blink(t, r() < 0.2);
  else if (p < 0.9) plan.glance(t, (r() < 0.5 ? -1 : 1) * 0.85, (r() - 0.6) * 0.4, 0.8 + r() * 0.7, canBlink && r() < 0.6, 0.5);
  else {
    plan.blink(t);
    plan.blink(t + 1.1);
  }
};

/** A large avatar's own life: blinks every 2.6 to 6.2 s, a glance every 5.5 to 10.5 s (sometimes to one side, then
 * across to the other, then home), and a slow breath that is never quite even. */
export class Life {
  private readonly plan: Plan;
  private readonly canBlink: boolean;
  private readonly r: () => number;
  private nextBlink: number;
  private nextGlance: number;
  private nextBreath: number;
  private up = false;

  constructor(plan: Plan, seed: number, now: number, canBlink: boolean) {
    this.plan = plan;
    this.canBlink = canBlink;
    this.r = random(seed);
    this.nextBlink = now + 1.2 + this.r() * 1.5;
    this.nextGlance = now + 2.6 + this.r() * 2;
    this.nextBreath = now + 0.4;
  }

  /** Plans its moves up to `until`. */
  ahead(until: number): void {
    const { r, plan } = this;
    while (this.nextBreath < until) {
      this.up = !this.up;
      plan.add(BREATH, this.nextBreath, this.up ? 1 : -1, SPRINGS.breath);
      this.nextBreath += this.up ? 1.9 + r() * 0.4 : 2.5 + r() * 0.6;
    }
    while (this.canBlink && this.nextBlink < until) {
      plan.blink(this.nextBlink, r() < 0.18);
      this.nextBlink += 2.6 + r() * 3.6;
    }
    while (this.nextGlance < until) {
      const t = this.nextGlance;
      const side = r() < 0.5 ? -1 : 1;
      const hold = 0.9 + r() * 1.3;
      if (r() < 0.3) {
        // One way, across to the other, then home.
        if (this.canBlink) plan.blink(t - 0.03);
        plan.add(GX, t, side * 0.85, SPRINGS.gazeGo);
        plan.add(LEAN_CH, t + 0.06, side * 0.7, SPRINGS.lean);
        plan.add(GX, t + 1.0, -side * 1.7, SPRINGS.gazeGo);
        plan.add(LEAN_CH, t + 1.06, -side * 1.4, SPRINGS.lean);
        plan.add(GX, t + 2.1, side * 0.85, SPRINGS.gazeBack);
        plan.add(LEAN_CH, t + 2.15, side * 0.7, SPRINGS.lean);
        this.nextBlink = Math.max(this.nextBlink, t + 2.9);
      } else {
        plan.glance(t, side * (0.7 + r() * 0.3), (r() - 0.6) * 0.5, hold, this.canBlink && r() < 0.55, 0.8);
        this.nextBlink = Math.max(this.nextBlink, t + hold + 0.8);
      }
      this.nextGlance += 5.5 + r() * 5;
    }
  }
}
