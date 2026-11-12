// The bot every project wears until a person gives it a picture, on the desktop (ui/primitives/Bot.tsx) and
// the phone alike: one character for every bot (D377, the bot-avatar report with its eyes C, Button), a soft dumpling
// of calm slate, or the color a person picked for its project (BOT_PAINT), with two eyes and no mouth, standing free
// with no circle behind it (Pebble, from the avatar-no-circle report, without its contact shadow). Its motion says what
// it is doing: idle, thinking, working, needs you, done, or an error.
//
// It is all here, pure, so both apps draw and move it alike. One rig: every frame is drawn from a few channels (the
// lids, the eyes' size and look, the body's squash, lift and lean, the eyes' glow and dim). Each channel is a damped
// spring (mass 1) chasing its state's pose plus that state's loops, stepped at a fixed 1/120 s and drawn once per
// display frame. A bot's clock never restarts and each loop's amplitude is a spring too, so a state change moves only
// the targets: the bot blends from its current pose and phase, and an arrival nudges the body's speed, never its place.
// With reduced motion the loops, blinks and glances stop and each state settles, critically damped, into its still pose.
// Below 44 px, as drawn (drawnAt: its box shows only its body, so a 36 px box draws it at 45), the rig sizes
// itself for small use: larger, slightly wider eyes, 0.8 of the body motion, a closed eye never thinner than 1 px, and
// no glow.
//
// In a list an idle bot waits for its turn (moment: a blink or a glance, one bot at a time), and sleeps between
// them; a bot in any other state, or one that lives on its own (solo, a large one), keeps moving. Asleep its clock
// stops, so it wakes exactly where it was. The functions the phone runs on its UI thread are worklets ("worklet"), a
// plain string to the desktop.

import type { KnownBotColor } from "./contracts";

/** What a bot shows, from the app's own words (projects/botState.ts). */
export type BotState = "idle" | "thinking" | "working" | "needs" | "done" | "error";
export const BOT_STATES: readonly BotState[] = ["idle", "thinking", "working", "needs", "done", "error"];

/** What the app knows of a project, for its bot. */
export interface BotIn {
  /** The lead waits on you, or a secret or an approval does. */
  readonly needs: boolean;
  /** Something outside the work blocks it. */
  readonly blocked: boolean;
  /** Agents at work, the lead not counted. */
  readonly running: number;
  /** What the lead does now ("thinking", "editing `a.ts`"); undefined while it's idle. */
  readonly doing: string | undefined;
  /** It has something new for you: a reply not yet seen, or a turn that just ended. */
  readonly done: boolean;
}

/** A project's bot: it needs you, else it's blocked (an error), else its agents or lead work (the lead thinking or
 * planning alone: thinking), else it has a new reply for you (done), else idle. */
export const botStateOf = ({ needs, blocked, running, doing, done }: BotIn): BotState => {
  if (needs) return "needs";
  if (blocked) return "error";
  if (doing === "thinking" || doing === "planning") return running > 0 ? "working" : "thinking";
  if (doing !== undefined || running > 0) return "working";
  return done ? "done" : "idle";
};

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

// ---- The drawing, in a 100×100 box

/** A round crown, full shoulders and a flat seat it rests on, at SEAT. Its bounds are x 14.5 to 85.5, y 22 to 85. */
export const BODY = "M50 22C66.2 22 79.6 33.2 83.2 50.6C85.9 63.6 84.2 75.6 72.4 81.4C66.2 84.4 58.6 85 50 85C41.4 85 33.8 84.4 27.6 81.4C15.8 75.6 14.1 63.6 16.8 50.6C20.4 33.2 33.8 22 50 22Z";
const SEAT_X = 50;
const SEAT_Y = 85;

/** The part of the 100 box a bot shows: the body at 80% of the drawing, centred on its optical centre (50, 54.6),
 * halfway from its bounds' centre to its area's centroid, which sits low, so its weight lands on a row's centre line.
 * Its hops and slumps reach past the box, so whatever holds it never clips it. */
export const CROP = { x: 10, y: 14.6, w: 80 } as const;
export const VIEW_BOX = `${CROP.x} ${CROP.y} ${CROP.w} ${CROP.w}`;
/** The size a bot in a `box` px box is drawn at, as if its whole 100 box showed: its size for newRig. */
export const drawnAt = (box: number): number => {
  "worklet";
  return (box * 100) / CROP.w;
};

/** What a bot is painted with (Pebble): one flat body and its eyes, in the color its project picked (BOT_PAINT). */
export interface Paint {
  readonly body: string;
  /** Its eyes, and their glow's strength at its fullest. */
  readonly eye: string;
  readonly glowA: number;
}

/** The colors a bot comes in (the contracts' BotColor), in the order a picker shows them: slate, the default, and the
 * neutral, then round the wheel. */
export const BOT_COLORS: readonly KnownBotColor[] = ["slate", "mono", "blue", "lilac", "coral", "amber", "sage", "teal"];
export type BotColorName = KnownBotColor;

/**
 * Each color's paint in both themes: one flat body, its eyes and their glow. The hues sit round the wheel at one calm
 * chroma (no neon); each body is dark enough in light for white eyes to read at 20 px (at least 3.7:1) and in dark
 * light enough to stand off the screen (at least 4.3:1) while keeping Done's crescents (at least 3.4:1).
 */
export const BOT_PAINT: { readonly [C in BotColorName]: { readonly light: Paint; readonly dark: Paint } } = {
  /** One calm dusk slate (hue 258, low chroma), the default: dark enough in light for white eyes to read at 20 px
   * (about 5.5:1), light enough in dark to stand off the screen and still keep Done's crescents (about 4:1). */
  slate: {
    light: { body: oklch(0.5, 0.062, 258), eye: oklch(0.99, 0.006, 258), glowA: 0.35 },
    dark: { body: oklch(0.6, 0.06, 258), eye: oklch(0.995, 0.004, 258), glowA: 0.4 },
  },
  /** The app's own neutral: near-black in light and near-white in dark, which takes dark eyes and no glow. */
  mono: {
    light: { body: oklch(0.29, 0.01, 260), eye: oklch(0.98, 0.004, 258), glowA: 0.35 },
    dark: { body: oklch(0.94, 0.005, 250), eye: oklch(0.25, 0.015, 258), glowA: 0 },
  },
  blue: {
    light: { body: oklch(0.57, 0.13, 252), eye: oklch(0.99, 0.006, 252), glowA: 0.35 },
    dark: { body: oklch(0.615, 0.12, 252), eye: oklch(0.995, 0.004, 252), glowA: 0.4 },
  },
  lilac: {
    light: { body: oklch(0.57, 0.1, 298), eye: oklch(0.99, 0.006, 298), glowA: 0.35 },
    dark: { body: oklch(0.625, 0.095, 298), eye: oklch(0.995, 0.004, 298), glowA: 0.4 },
  },
  coral: {
    light: { body: oklch(0.62, 0.12, 33), eye: oklch(0.99, 0.006, 33), glowA: 0.35 },
    dark: { body: oklch(0.645, 0.115, 33), eye: oklch(0.995, 0.004, 33), glowA: 0.4 },
  },
  /** Too light for white eyes in either theme: dark ones, with no glow. */
  amber: {
    light: { body: oklch(0.76, 0.11, 75), eye: oklch(0.3, 0.035, 60), glowA: 0 },
    dark: { body: oklch(0.8, 0.105, 78), eye: oklch(0.27, 0.035, 60), glowA: 0 },
  },
  sage: {
    light: { body: oklch(0.59, 0.085, 152), eye: oklch(0.99, 0.006, 152), glowA: 0.35 },
    dark: { body: oklch(0.625, 0.085, 152), eye: oklch(0.995, 0.004, 152), glowA: 0.4 },
  },
  teal: {
    light: { body: oklch(0.57, 0.075, 200), eye: oklch(0.99, 0.006, 200), glowA: 0.35 },
    dark: { body: oklch(0.615, 0.075, 200), eye: oklch(0.995, 0.004, 200), glowA: 0.4 },
  },
};

/** A color's name, as a picker says it. */
export const botColorLabel = (color: BotColorName): string => color.charAt(0).toUpperCase() + color.slice(1);

/** The paint of a bot of `color` (slate for none, or one a newer hub added), in the app's theme. */
export const paintOf = (color: string | undefined, dark: boolean): Paint => {
  const p = (BOT_PAINT as Record<string, { readonly light: Paint; readonly dark: Paint } | undefined>)[color ?? "slate"] ?? BOT_PAINT.slate;
  return dark ? p.dark : p.light;
};

/** The eyes (Button): tall rounded-square ovals, half `hx` apart, their tops leaning in `tilt`°, never out (which
 * reads as a frown); `n` is the superellipse's roundness (2 an ellipse); `up` the upper lid a hair down at rest. */
const EYE = { hx: 12.8, y: 58.5, rx: 5.0, ry: 7.6, n: 2.3, tilt: 6, up: 0.03 } as const;

// ---- The channels, their rest and their springs

export const UP = 0;
export const SLOPE = 1;
export const LOW = 2;
export const EYES = 3;
export const GX = 4;
export const GY = 5;
export const SQUASH = 6;
export const LIFT = 7;
export const LEAN = 8;
export const GLOW = 9;
export const DIM = 10;
const CHANNELS = 11;

type Channels = { up?: number; slope?: number; low?: number; eyes?: number; gx?: number; gy?: number; squash?: number; lift?: number; lean?: number; glow?: number; dim?: number };
/** By channel, each 0 unless given, and the eyes' size `eyes` (1 for a pose, 0 for a nudge). */
const channels = (c: Channels, eyes = 1): number[] => [c.up ?? 0, c.slope ?? 0, c.low ?? 0, c.eyes ?? eyes, c.gx ?? 0, c.gy ?? 0, c.squash ?? 0, c.lift ?? 0, c.lean ?? 0, c.glow ?? 0, c.dim ?? 0];
const kicks = (c: Channels): number[] => channels(c, 0);

/** Each channel's spring [stiffness, damping], two by two: the lids (ζ 0.81, about 0.45 s), the look (a saccade, about
 * 2% over), the body (a soft jiggle, about 8% over), then the glow and dim (about 0.9 s). */
const SPRING = [220, 24, 220, 24, 220, 24, 220, 24, 260, 25, 260, 25, 140, 15, 140, 15, 140, 15, 50, 13, 50, 13];
/** Springs, mass 1: a loop fading in or out (critically damped, about a second); a lid shutting in about 70 ms,
 * opening in about 170, or a tired one; and with reduced motion every channel, critically damped in about 150 ms. */
export const SPRINGS = {
  amp: [40, 12.6],
  close: [1500, 66],
  open: [560, 40],
  openSlow: [170, 24],
  calm: [500, 44.7],
} as const;

/** The fixed step, in seconds. */
export const STEP = 1 / 120;

// ---- The loops, each adding to the pose, scaled by its amplitude

const BREATH = 0;
const READ = 1;
const PONDER = 2;
const PERK = 3;
const SWAY = 4;
const SIGH = 5;
/** The idle glances' share of the look: a channel of its own rather than a loop. */
const GLANCE = 6;
const LOOPS = 7;

const TAU = Math.PI * 2;

const bump = (p: number, a: number, b: number): number => {
  "worklet";
  return p < a || p > b ? 0 : Math.sin((Math.PI * (p - a)) / (b - a)) ** 2;
};

/** Adds each loop at its amplitude in `a` to `o` at `t`; `B` scales the body's share (smaller in lists). */
const loops = (t: number, a: readonly number[], o: number[], B: number): void => {
  "worklet";
  // An uneven breath (4.4 s).
  const br = a[BREATH] ?? 0;
  if (br !== 0) {
    const s = Math.sin((TAU * t) / 4.4) + 0.22 * Math.sin((TAU * t) / 1.7 + 1.3);
    o[SQUASH] = (o[SQUASH] ?? 0) - 0.02 * br * B * s;
    o[LIFT] = (o[LIFT] ?? 0) + 0.63 * br * B * s;
    o[GY] = (o[GY] ?? 0) - 0.045 * br * s;
  }
  // Reading: four fixations across a line, a saccade back, and a small nod at each new line (2.7 s).
  const rd = a[READ] ?? 0;
  if (rd !== 0) {
    const p = (t / 2.7) % 1;
    const x = p < 0.84 ? -1 + (2 * Math.floor((p / 0.84) * 4)) / 3 : -1;
    const nod = bump(p, 0.8, 1);
    o[GX] = (o[GX] ?? 0) + 0.5 * rd * x;
    o[GY] = (o[GY] ?? 0) + 0.24 * rd * nod;
    o[LIFT] = (o[LIFT] ?? 0) - 1.35 * rd * B * nod;
    o[SQUASH] = (o[SQUASH] ?? 0) + 0.03 * rd * B * nod;
  }
  // Pondering: the look drifts in a slow circle (3.8 s), a slow sway.
  const pd = a[PONDER] ?? 0;
  if (pd !== 0) {
    const w = (TAU * t) / 3.8;
    o[GX] = (o[GX] ?? 0) + 0.26 * pd * Math.sin(w);
    o[GY] = (o[GY] ?? 0) + 0.15 * pd * Math.cos(w);
    o[LEAN] = (o[LEAN] ?? 0) + 2.7 * pd * B * Math.sin((TAU * t) / 5.6);
  }
  // Attentive: a small perk up every 3.2 s, the eyes a touch wider at its top, a slow curious tilt.
  const pk = a[PERK] ?? 0;
  if (pk !== 0) {
    const q = bump((t / 3.2) % 1, 0, 0.24);
    o[LIFT] = (o[LIFT] ?? 0) + 1.8 * pk * B * q;
    o[SQUASH] = (o[SQUASH] ?? 0) - 0.045 * pk * B * q;
    o[EYES] = (o[EYES] ?? 0) + 0.045 * pk * q;
    o[LEAN] = (o[LEAN] ?? 0) + 1.65 * pk * B * Math.sin((TAU * t) / 6.4);
  }
  // Content: a slow sway (5 s), the look trailing it.
  const sw = a[SWAY] ?? 0;
  if (sw !== 0) {
    o[LEAN] = (o[LEAN] ?? 0) + 2.7 * sw * B * Math.sin((TAU * t) / 5);
    o[GX] = (o[GX] ?? 0) + 0.14 * sw * Math.sin((TAU * t) / 5 - 0.6);
  }
  // Low: a slow breath with a sigh in it every 6 s.
  const sg = a[SIGH] ?? 0;
  if (sg !== 0) {
    const s = Math.sin((TAU * t) / 6);
    const q = bump((t / 6) % 1, 0.55, 0.95);
    o[SQUASH] = (o[SQUASH] ?? 0) + sg * B * (0.015 * s + 0.048 * q);
    o[LIFT] = (o[LIFT] ?? 0) - sg * B * (0.53 * s + 1.35 * q);
    o[GY] = (o[GY] ?? 0) + 0.1 * sg * q;
    o[UP] = (o[UP] ?? 0) + 0.07 * sg * q;
  }
};

// ---- The states

interface Mood {
  /** The target pose, by channel. */
  readonly pose: readonly number[];
  /** Each loop's amplitude. */
  readonly loops: readonly number[];
  /** Seconds between its own blinks, [least, most]; none for a bot whose eyes smile shut. */
  readonly blink: readonly [number, number] | null;
  /** How often a blink comes twice. */
  readonly twice: number;
  /** Its lids open slowly, tired. */
  readonly slow: boolean;
  /** On arriving, a nudge to the body's speed, by channel. */
  readonly kick: readonly number[];
}

const amps = (l: { breath?: number; read?: number; ponder?: number; perk?: number; sway?: number; sigh?: number; glance?: number }): number[] => [
  l.breath ?? 0,
  l.read ?? 0,
  l.ponder ?? 0,
  l.perk ?? 0,
  l.sway ?? 0,
  l.sigh ?? 0,
  l.glance ?? 0,
];

/** Each state: its pose, its loops and its arrival (the report's table). */
export const MOODS: { readonly [S in BotState]: Mood } = {
  // Neutral: an uneven breath, a blink every 2 to 4.6 s (sometimes two), a glance aside every 4 to 7.5 s.
  idle: { pose: channels({}), loops: amps({ breath: 1, glance: 1 }), blink: [2, 4.6], twice: 0.2, slow: false, kick: kicks({}) },
  // Looks up and aside, head tilted; the look drifts in a slow circle. Arrives with a small lift.
  thinking: { pose: channels({ gx: -0.62, gy: -0.74, lean: -2.4, eyes: 0.97 }), loops: amps({ breath: 0.7, ponder: 1 }), blink: [2.4, 4.8], twice: 0.1, slow: false, kick: kicks({ lift: 7 }) },
  // Looks down, lids a touch lower, and reads. Arrives with a squish.
  working: { pose: channels({ gy: 0.68, up: 0.1, squash: 0.018 }), loops: amps({ breath: 0.45, read: 1 }), blink: [3.4, 6], twice: 0, slow: false, kick: kicks({ squash: 0.28 }) },
  // Sits up taller, eyes bigger with a faint glow, looks at you, perks up. Arrives with a hop.
  needs: { pose: channels({ lift: 3, squash: -0.042, eyes: 1.1, gy: -0.16, glow: 1, lean: 3.2 }), loops: amps({ breath: 0.5, perk: 1 }), blink: [2, 3.8], twice: 0.45, slow: false, kick: kicks({ lift: 24, squash: -0.5 }) },
  // Crescent eyes from the lower lid, settled a touch wider; a deeper breath and a slow sway. A happy squish.
  done: { pose: channels({ low: 0.68, up: 0.04, squash: 0.03, lift: -0.6 }), loops: amps({ breath: 1.35, sway: 1 }), blink: null, twice: 0, slow: false, kick: kicks({ squash: 0.6 }) },
  // Lids drop, lower at the outer corners; looks down, sinks and slumps; dimmer eyes; a sigh every 6 s. A slump.
  error: { pose: channels({ up: 0.42, slope: 0.6, gy: 0.72, gx: 0.16, squash: 0.065, lift: -2.8, lean: -3.8, dim: 1, eyes: 0.96 }), loops: amps({ sigh: 1 }), blink: [4, 7], twice: 0, slow: true, kick: kicks({ lift: -9, squash: 0.35 }) },
};

// ---- One bot's rig

/** A bot's whole moving state, plain numbers, so the phone keeps it in a shared value and steps it on its UI thread. */
export interface Rig {
  state: BotState;
  /** Its own clock, in seconds: it never restarts, and it stops while the bot sleeps. */
  t: number;
  /** Time not yet stepped. */
  acc: number;
  /** Where its loops start, so no two bots breathe together. */
  phase: number;
  /** Its random's state (mulberry32). */
  seed: number;
  /** It blinks and glances by itself, even idle (a large one); else it waits for its moments (a list's). */
  solo: boolean;
  /** Each channel's place and speed, and each loop's amplitude and its speed. */
  x: number[];
  v: number[];
  amp: number[];
  ampV: number[];
  /** The blink, 0 open to 1 shut, its speed, and the blinks to come, [start, end] two by two. */
  bk: number;
  bkV: number;
  blinks: number[];
  nextBlink: number;
  /** An idle glance: where it looks, until when, and when the next one comes. */
  gx: number;
  gy: number;
  glanceEnd: number;
  nextGlance: number;
  /** It keeps moving until then, though idle in a list: a moment's or a change's springs settling. */
  awake: number;
  // Its size's rules.
  eyeK: number;
  gapK: number;
  B: number;
  minT: number;
  glow: boolean;
  points: number;
}

/** The size from which a bot lives on its own, rather than taking turns in a list. */
export const LARGE = 80;
/** Below this size, as drawn, the small-size rules apply. */
export const SMALL = 44;

const rnd = (r: Rig): number => {
  "worklet";
  r.seed = (r.seed + 0x6d2b79f5) | 0;
  let t = Math.imul(r.seed ^ (r.seed >>> 15), 1 | r.seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** The channels' targets now: the pose, each loop on top, and the idle glance. */
const target = (r: Rig, calm: boolean): number[] => {
  "worklet";
  const m = MOODS[r.state];
  const o = m.pose.slice();
  if (!calm) {
    loops(r.t + r.phase, r.amp, o, r.B);
    const g = r.amp[GLANCE] ?? 0;
    o[GX] = (o[GX] ?? 0) + r.gx * g;
    o[GY] = (o[GY] ?? 0) + r.gy * g;
  }
  return o;
};

/** A bot of `size` px in `state`, arrived and settled in it. */
export const newRig = (state: BotState, size: number, seed: number, solo = size >= LARGE): Rig => {
  "worklet";
  const o = Math.max(0, Math.min(1, (SMALL - size) / 24));
  const r: Rig = {
    state,
    t: 0,
    acc: 0,
    phase: 0,
    seed,
    solo,
    x: [],
    v: [],
    amp: MOODS[state].loops.slice(),
    ampV: [0, 0, 0, 0, 0, 0, 0],
    bk: 0,
    bkV: 0,
    blinks: [],
    nextBlink: 0,
    gx: 0,
    gy: 0,
    glanceEnd: -1,
    nextGlance: 0,
    awake: -1,
    eyeK: 1 + 0.2 * o,
    gapK: 1 + 0.05 * o,
    B: 1 - 0.2 * o,
    minT: Math.max(1.9, (100 / size) * 1.05),
    glow: size >= SMALL,
    points: size >= SMALL ? 22 : 14,
  };
  r.phase = rnd(r) * 20;
  r.nextBlink = 1 + rnd(r) * 2;
  r.nextGlance = 2.5 + rnd(r) * 3;
  r.x = target(r, false);
  for (let i = 0; i < CHANNELS; i++) r.v.push(0);
  return r;
};

const blinkAt = (r: Rig, t: number): void => {
  "worklet";
  r.blinks.push(t, t + 0.075);
};

/** It moves now (or will this frame): a list's idle bot sleeps once its moment or change has settled. */
export const isAwake = (r: Rig, calm: boolean): boolean => {
  "worklet";
  return r.t < r.awake || (!calm && (r.solo || r.state !== "idle"));
};

/** A new state: only the targets change, and the body takes a nudge to its speed. */
export const setRigState = (r: Rig, state: BotState, calm: boolean): void => {
  "worklet";
  if (state === r.state) return;
  r.state = state;
  // Its springs settle in about 2.5 s (with reduced motion, well under a second).
  r.awake = r.t + (calm ? 0.6 : 2.5);
  if (calm) return;
  const k = MOODS[state].kick;
  for (let i = 0; i < CHANNELS; i++) r.v[i] = (r.v[i] ?? 0) + (k[i] ?? 0) * (i === LIFT ? r.B : 1);
  // A first blink comes sooner in a new state.
  r.nextBlink = Math.min(r.nextBlink, r.t + 0.8 + rnd(r) * 1.6);
};

/** A list's idle moment, its turn among the bots on screen: a blink (55%, sometimes two), a glance aside (35%), or
 * two blinks a second apart. */
export const moment = (r: Rig): void => {
  "worklet";
  const p = rnd(r);
  const t = r.t + 0.02;
  if (p < 0.55) {
    blinkAt(r, t);
    if (rnd(r) < 0.2) blinkAt(r, t + 0.28);
    r.awake = t + 1.2;
  } else if (p < 0.9) {
    const side = rnd(r) < 0.5 ? -1 : 1;
    r.gx = side * (0.8 + rnd(r) * 0.35);
    r.gy = (rnd(r) - 0.6) * 0.5;
    r.glanceEnd = t + 0.8 + rnd(r) * 0.7;
    if (rnd(r) < 0.6) blinkAt(r, t - 0.02);
    r.awake = r.glanceEnd + 1.4;
  } else {
    blinkAt(r, t);
    blinkAt(r, t + 1.1);
    r.awake = t + 2.3;
  }
};

/** One fixed step of `h` seconds. */
const step = (r: Rig, h: number, calm: boolean): void => {
  "worklet";
  const m = MOODS[r.state];
  r.t += h;
  // Loop amplitudes spring toward the state's.
  const [ka, ca] = SPRINGS.amp;
  for (let i = 0; i < LOOPS; i++) {
    if (calm) {
      r.amp[i] = 0;
      r.ampV[i] = 0;
      continue;
    }
    const a = r.amp[i] ?? 0;
    const av = (r.ampV[i] ?? 0) + (ka * ((m.loops[i] ?? 0) - a) - ca * (r.ampV[i] ?? 0)) * h;
    r.ampV[i] = av;
    r.amp[i] = a + av * h;
  }
  // Its own glances (a solo bot's; a list's come as moments), and their end.
  if (!calm && r.solo && r.t >= r.nextGlance) {
    const side = rnd(r) < 0.5 ? -1 : 1;
    r.gx = side * (0.8 + rnd(r) * 0.35);
    r.gy = (rnd(r) - 0.6) * 0.6;
    r.glanceEnd = r.t + 0.9 + rnd(r) * 1.2;
    r.nextGlance = r.t + 4 + rnd(r) * 3.5;
    if (rnd(r) < 0.55) blinkAt(r, r.t - 0.02);
  }
  if (r.t >= r.glanceEnd) {
    r.gx = 0;
    r.gy = 0;
  }
  // The channels.
  const tg = target(r, calm);
  for (let i = 0; i < CHANNELS; i++) {
    const k = calm ? SPRINGS.calm[0] : (SPRING[i * 2] ?? 1);
    const d = calm ? SPRINGS.calm[1] : (SPRING[i * 2 + 1] ?? 1);
    const x = r.x[i] ?? 0;
    const v = (r.v[i] ?? 0) + (k * ((tg[i] ?? 0) - x) - d * (r.v[i] ?? 0)) * h;
    r.v[i] = v;
    r.x[i] = x + v * h;
  }
  // Its own blinks (idle in a list, only its moments'): none with reduced motion, none while the eyes are mostly shut.
  const open = 1 - Math.max((r.x[UP] ?? 0) + EYE.up, r.x[LOW] ?? 0);
  if (!calm && m.blink !== null && (r.solo || r.state !== "idle") && r.t >= r.nextBlink) {
    if (open > 0.55) {
      blinkAt(r, r.t);
      if (rnd(r) < m.twice) blinkAt(r, r.t + 0.28);
    }
    r.nextBlink = r.t + m.blink[0] + rnd(r) * (m.blink[1] - m.blink[0]);
  }
  let shut = false;
  const left: number[] = [];
  for (let i = 0; i + 1 < r.blinks.length; i += 2) {
    const a = r.blinks[i] ?? 0;
    const b = r.blinks[i + 1] ?? 0;
    if (r.t >= a && r.t < b) shut = true;
    if (b > r.t) left.push(a, b);
  }
  r.blinks = left;
  if (calm) shut = false;
  const [kb, cb] = shut ? SPRINGS.close : m.slow ? SPRINGS.openSlow : SPRINGS.open;
  r.bkV += (kb * ((shut ? 1 : 0) - r.bk) - cb * r.bkV) * h;
  r.bk += r.bkV * h;
};

/** Moves the bot on by `dt` seconds of the display's time, in fixed steps. */
export const advanceRig = (r: Rig, dt: number, calm: boolean): void => {
  "worklet";
  r.acc += Math.min(0.05, Math.max(0, dt));
  while (r.acc >= STEP) {
    step(r, STEP, calm);
    r.acc -= STEP;
  }
};

// ---- A frame, drawn

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

const f2 = (v: number): string => {
  "worklet";
  return String(Math.round(v * 100) / 100);
};

/**
 * An eye: a superellipse cut by an upper lid and a lower lid, closing to a soft tapered line, never a hole. The upper
 * lid's edge partly follows the eye's own arc (so a lowered lid is a soft lens, never a flat cut) and sits lower at the
 * outer corner by `slope`; the lower lid rises along the eye's curve, so a raised one makes a crescent that tapers to
 * its corners. Its outline goes into `out` as the points of a closed Catmull-Rom, x and y by turns, along the top
 * left to right and back along the bottom, its ends shared: `points` + 1 along each lid. Returns how many points.
 */
const eyeOutline = (out: number[], cx: number, cy: number, rx: number, ry: number, up: number, slope: number, low: number, blink: number, side: number, minT: number, points: number): number => {
  "worklet";
  const a = (-side * EYE.tilt * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const k = 1 - 0.93 * blink;
  const pivot = ry * 0.3;
  const sl = slope * Math.min(1, up * 3);
  for (let i = 0; i <= points; i++) {
    const u = -Math.cos((Math.PI * i) / points);
    const x = rx * u;
    const f = (1 - Math.abs(u) ** EYE.n) ** (1 / EYE.n);
    const edge = 1 - u * u;
    const lidU = 0.45 * (-ry + 2 * ry * up) + 0.55 * (-ry * f + 2 * ry * f * up) + sl * ry * 0.5 * (u * side + 0.35);
    const lidB = ry * f - 2 * ry * f * low * (0.82 + 0.18 * edge);
    let yT = pivot + (Math.max(-ry * f, lidU) - pivot) * k;
    let yB = pivot + (Math.min(ry * f, lidB) - pivot) * k;
    const mt = minT * Math.sqrt(f);
    if (yB - yT < mt) {
      const mid = (yT + yB) / 2;
      yT = mid - mt / 2;
      yB = mid + mt / 2;
    }
    out[i * 2] = cx + x * c - yT * s;
    out[i * 2 + 1] = cy + x * s + yT * c;
    if (i > 0 && i < points) {
      const j = 2 * points - i;
      out[j * 2] = cx + x * c - yB * s;
      out[j * 2 + 1] = cy + x * s + yB * c;
    }
  }
  return 2 * points;
};

/** An eye's outline (eyeOutline: `L` points in `P`) as SVG path data, in cubics. */
const eyePath = (P: readonly number[], L: number): string => {
  "worklet";
  const X = (i: number) => P[((i + L) % L) * 2] ?? 0;
  const Y = (i: number) => P[((i + L) % L) * 2 + 1] ?? 0;
  let d = `M${f2(X(0))} ${f2(Y(0))}`;
  for (let i = 0; i < L; i++) {
    d += `C${f2(X(i) + (X(i + 1) - X(i - 1)) / 6)} ${f2(Y(i) + (Y(i + 1) - Y(i - 1)) / 6)} ${f2(X(i + 1) - (X(i + 2) - X(i)) / 6)} ${f2(Y(i + 1) - (Y(i + 2) - Y(i)) / 6)} ${f2(X(i + 1))} ${f2(Y(i + 1))}`;
  }
  return `${d}Z`;
};

/** The rig's eye on `side` (-1 left, 1 right) into `out` (eyeOutline): the face slides toward the look, as on a ball
 * turning, and the far eye narrows. */
const eyeOf = (r: Rig, side: number, out: number[]): number => {
  "worklet";
  const x = r.x;
  const gx = x[GX] ?? 0;
  const t = Math.min(1, Math.abs(gx));
  const es = x[EYES] ?? 1;
  return eyeOutline(
    out,
    50 + side * EYE.hx * r.gapK * (1 - 0.07 * t) + gx * 4.4,
    EYE.y + (x[GY] ?? 0) * 3.4,
    EYE.rx * r.eyeK * es * (1 - 0.14 * Math.max(0, gx * side)),
    EYE.ry * r.eyeK * es,
    Math.max(0, Math.min(1, EYE.up + (x[UP] ?? 0))),
    x[SLOPE] ?? 0,
    Math.max(0, Math.min(1, x[LOW] ?? 0)),
    Math.max(0, Math.min(1, r.bk)),
    side,
    r.minT,
    r.points,
  );
};

/** The body's matrix: squashed about its seat, keeping its volume, leaned and lifted. */
export const bodyOf = (r: Rig): Matrix => {
  "worklet";
  const sq = r.x[SQUASH] ?? 0;
  const lean = r.x[LEAN] ?? 0;
  return mul(move(lean * 0.3, -(r.x[LIFT] ?? 0)), mul(move(SEAT_X, SEAT_Y), mul(turn(lean), mul(scale(1 + sq * 0.8, 1 - sq), move(-SEAT_X, -SEAT_Y)))));
};

/** The eyes' glow, 0 to 1.2 (none for a small bot), and their dimming, 0 to 1. */
export const glowOf = (r: Rig): number => {
  "worklet";
  return r.glow ? Math.max(0, Math.min(1.2, r.x[GLOW] ?? 0)) : 0;
};
export const dimOf = (r: Rig): number => {
  "worklet";
  return Math.max(0, Math.min(1, r.x[DIM] ?? 0));
};

/** Something an outline is traced with, as a canvas's 2D context is. */
export interface Pen {
  moveTo(x: number, y: number): void;
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
  closePath(): void;
}

/** Traces both eyes with `pen`, in the body's space, as the same cubics as frameOf's paths, with no strings and, once
 * `out` holds an eye, nothing allocated: what a canvas draws each display frame (ui/lib/botLife.ts). */
export const traceEyes = (r: Rig, pen: Pen, out: number[]): void => {
  for (const side of [-1, 1]) {
    const L = eyeOf(r, side, out);
    const X = (i: number) => out[((i + L) % L) * 2] ?? 0;
    const Y = (i: number) => out[((i + L) % L) * 2 + 1] ?? 0;
    pen.moveTo(X(0), Y(0));
    for (let i = 0; i < L; i++) pen.bezierCurveTo(X(i) + (X(i + 1) - X(i - 1)) / 6, Y(i) + (Y(i + 1) - Y(i - 1)) / 6, X(i + 1) - (X(i + 2) - X(i)) / 6, Y(i + 1) - (Y(i + 2) - Y(i)) / 6, X(i + 1), Y(i + 1));
    pen.closePath();
  }
};

/** What a frame draws: the body's matrix (squashed about its seat, keeping its volume, leaned and lifted), each eye's
 * path, and the eyes' glow (0 to 1) and dimming (0 to 1). */
export interface Frame {
  readonly body: Matrix;
  readonly eyes: readonly [string, string];
  readonly glow: number;
  readonly dim: number;
}

export const frameOf = (r: Rig): Frame => {
  "worklet";
  const P: number[] = [];
  const eye = (side: number) => eyePath(P, eyeOf(r, side, P));
  return {
    body: bodyOf(r),
    eyes: [eye(-1), eye(1)],
    glow: glowOf(r),
    dim: dimOf(r),
  };
};

/** "matrix(a b c d e f)", for an SVG attribute. */
export const matrixAttr = (m: Matrix): string => `matrix(${m.map((v) => String(Math.round(v * 10000) / 10000)).join(" ")})`;

/** How much a dimmed eye's fill gives up. */
export const DIMMED = 0.14;

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

/** In a list, the rest between one bot's moment and the next one's, in seconds: 1.6 to 3.6. */
export const listRest = (r: () => number): number => 1.6 + r() * 2;
