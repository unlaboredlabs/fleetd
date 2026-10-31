// A Navi's or agent's live screen on the phone, as plain logic: which screens a chat shows as cards and what each
// says, who has control, where a touch on the shown frame lands in the frame's own pixels (through the pinch zoom),
// what a finger does to the page (a tap clicks, a drag scrolls, a touch held first presses and drags, as for a slider
// or a press-and-hold captcha), what typing sends, and how often a frame is drawn. The hub's browser_watch,
// browser_input and browser_control carry it (contracts browser.rs), as the desktop's live view does; nothing here
// touches React Native, so it is unit-tested. The geometry runs in gestures on the UI thread too: worklets.
import type { BrowserFrame, BrowserInput, BrowserSession } from "./desktop";

/** Who drives a screen now: its agent, the person, or the agent again from its next step. */
export type Control = "agent" | "human" | "handing_back";

/**
 * The screen's control as the hub lists it (browser_control's answer and each browser.session event keep it current),
 * else as its newest frame says it: a still page sends no new frame when its control changes.
 */
export const controlOf = (session: Pick<BrowserSession, "control"> | undefined, frame: Pick<BrowserFrame, "control"> | undefined): Control => {
  const c = session?.control ?? frame?.control;
  return c === "human" ? "human" : c === "handing_back" ? "handing_back" : "agent";
};

/** A live screen's card in its chat: one asking for the person first, then the rest, newest first. */
export interface ScreenCard {
  readonly id: string;
  /** Its agent asked the person to take over, and waits: why, in its words. */
  readonly reason?: string;
  readonly purpose: string;
  readonly kind: "browser" | "android" | "ios" | "linux_desktop";
  readonly control: Control;
  /** A person opened it themselves (New screen): theirs to drive, with no agent to hand it to. */
  readonly own: boolean;
}

const KINDS = new Set(["android", "ios", "linux_desktop"]);

export const cardOf = (s: BrowserSession): ScreenCard => ({
  id: s.sessionId,
  ...(s.takeoverReason === undefined || s.control !== "agent" ? {} : { reason: s.takeoverReason }),
  purpose: s.purpose,
  kind: KINDS.has(s.kind ?? "") ? (s.kind as ScreenCard["kind"]) : "browser",
  control: controlOf(s, undefined),
  own: s.openedBy !== undefined,
});

/** The cards a chat shows: its live screens, the ones asking for you first. */
export const screenCards = (sessions: readonly BrowserSession[] | undefined): readonly ScreenCard[] =>
  (sessions ?? [])
    .filter((s) => s.state === "live")
    .map(cardOf)
    .sort((a, b) => Number(b.reason !== undefined) - Number(a.reason !== undefined));

/** What a screen is, in a word: "browser", "Android emulator"… */
export const KIND_WORD: Record<ScreenCard["kind"], string> = {
  browser: "browser",
  android: "Android emulator",
  ios: "iOS simulator",
  linux_desktop: "desktop",
};

/** A card's title: "Nova needs you" while it asks, else "Nova's browser". */
export const cardTitle = (card: ScreenCard, who: string): string => (card.reason !== undefined ? `${who} needs you` : card.own ? `Your ${KIND_WORD[card.kind]}` : `${who}'s ${KIND_WORD[card.kind]}`);

/** The live view's line under its title: who drives. */
export const controlLine = (control: Control, who: string, own: boolean): string =>
  control === "human" ? (own ? "Yours" : "You have control") : control === "handing_back" ? `Back to ${who} at its next step` : `${who} has control`;

/** A page's host for the bar, or "" when the frame says no URL. */
export const hostOf = (url: string | undefined): string => {
  if (url === undefined || url === "") return "";
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/iu.exec(url);
  return m?.[1]?.replace(/^www\./u, "").replace(/:\d+$/u, "") ?? "";
};

// ---- geometry: the frame fit in its box, zoomed and moved by a pinch ----

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** How far in a pinch zooms. */
export const MAX_ZOOM = 4;

/** The zoom and offset (from the box's centre) a pinch made; zoom 1, offset 0: the frame fits the box whole. */
export interface View {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

/** Points per frame pixel at zoom 1: the whole frame fits the box. */
export const fitScale = (box: Size, frame: Size): number => {
  "worklet";
  return Math.min(box.width / Math.max(1, frame.width), box.height / Math.max(1, frame.height));
};

/** The farthest the frame's centre moves from the box's, each way, at `zoom`: it never leaves a gap it could fill. */
export const reachOf = (box: Size, frame: Size, zoom: number): { x: number; y: number } => {
  "worklet";
  const s = fitScale(box, frame) * zoom;
  return { x: Math.max(0, (frame.width * s - box.width) / 2), y: Math.max(0, (frame.height * s - box.height) / 2) };
};

/** A view kept in bounds: zoom 1..MAX_ZOOM, the offset inside its reach. */
export const clampView = (box: Size, frame: Size, v: View): View => {
  "worklet";
  const zoom = Math.min(MAX_ZOOM, Math.max(1, v.zoom));
  const r = reachOf(box, frame, zoom);
  // + 0: no -0 where it can't move.
  return { zoom, x: Math.min(r.x, Math.max(-r.x, v.x)) + 0, y: Math.min(r.y, Math.max(-r.y, v.y)) + 0 };
};

/**
 * Where a point in the box (from its top left) is in the frame's pixels, through the view; null off the frame (the
 * bars beside a frame narrower than the box).
 */
export const toFrame = (p: { x: number; y: number }, box: Size, frame: Size, v: View): { x: number; y: number } | null => {
  const s = fitScale(box, frame) * v.zoom;
  const x = (p.x - box.width / 2 - v.x) / s + frame.width / 2;
  const y = (p.y - box.height / 2 - v.y) / s + frame.height / 2;
  if (x < 0 || y < 0 || x > frame.width || y > frame.height) return null;
  return { x: Math.round(x), y: Math.round(y) };
};

/** Frame pixels per point at this view: a finger's move in points, in the page's pixels. */
export const pixelsPerPoint = (box: Size, frame: Size, v: View): number => 1 / Math.max(1e-6, fitScale(box, frame) * v.zoom);

// ---- a finger on the page: tap, drag to scroll, hold to press and drag ----

/** Moving this far (points) before the hold makes a touch a scroll. */
export const SLOP = 8;
/** Held this long without moving, a touch presses: what follows drags with the button down. */
export const HOLD_MS = 350;
/** A second tap this soon after the first lifted, and this near, is a double click. */
export const DOUBLE_MS = 300;
const DOUBLE_NEAR = 24;

type Point = { readonly x: number; readonly y: number };

/** Where a touch is, on screen (points in the box) and in the frame (null off it). */
export interface Touch {
  readonly at: Point;
  readonly frame: Point | null;
  readonly t: number;
}

export type Finger =
  | { readonly t: "idle"; readonly lastTap?: Touch }
  | { readonly t: "down"; readonly start: Touch; readonly lastTap?: Touch }
  | { readonly t: "scrolling"; readonly last: Point; readonly anchor: Point }
  | { readonly t: "holding"; readonly last: Point };

export const IDLE: Finger = { t: "idle" };

export interface Step {
  readonly finger: Finger;
  readonly send: readonly BrowserInput[];
}

const mouse = (action: "pressed" | "released" | "moved", at: Point, clickCount = 1): BrowserInput =>
  action === "moved" ? { kind: "mouse", action, x: at.x, y: at.y, button: "left" } : { kind: "mouse", action, x: at.x, y: at.y, button: "left", clickCount };

const near = (a: Point, b: Point, d: number): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= d;

/** A finger lands. Off the frame, it does nothing. */
export const fingerDown = (f: Finger, touch: Touch): Step => {
  const lastTap = f.t === "idle" || f.t === "down" ? f.lastTap : undefined;
  return { finger: touch.frame === null ? { t: "idle" } : { t: "down", start: touch, ...(lastTap === undefined ? {} : { lastTap }) }, send: [] };
};

/**
 * The finger moved. Past the slop before the hold, it scrolls: the page moves with the finger (a wheel the other way,
 * in the frame's pixels, `scale` of them a point). Held, it drags with the button down.
 */
export const fingerMove = (f: Finger, touch: Touch, scale: number): Step => {
  if (f.t === "down") {
    if (near(touch.at, f.start.at, SLOP) || f.start.frame === null) return { finger: f, send: [] };
    return fingerMove({ t: "scrolling", last: f.start.at, anchor: f.start.frame }, touch, scale);
  }
  if (f.t === "scrolling") {
    const dx = (touch.at.x - f.last.x) * scale;
    const dy = (touch.at.y - f.last.y) * scale;
    const send: BrowserInput[] = dx === 0 && dy === 0 ? [] : [{ kind: "mouse", action: "wheel", x: f.anchor.x, y: f.anchor.y, deltaX: -dx, deltaY: -dy }];
    return { finger: { ...f, last: touch.at }, send };
  }
  if (f.t === "holding" && touch.frame !== null) return { finger: { t: "holding", last: touch.frame }, send: [mouse("moved", touch.frame)] };
  return { finger: f, send: [] };
};

/** The hold's time came with the finger still down and still: it presses where it landed. */
export const fingerHeld = (f: Finger): Step => {
  if (f.t !== "down" || f.start.frame === null) return { finger: f, send: [] };
  return { finger: { t: "holding", last: f.start.frame }, send: [mouse("pressed", f.start.frame)] };
};

/** The finger lifts: a tap clicks (twice, soon after another nearby), a hold releases, a scroll just ends. */
export const fingerUp = (f: Finger, touch: Touch): Step => {
  if (f.t === "holding") return { finger: IDLE, send: [mouse("released", touch.frame ?? f.last)] };
  if (f.t !== "down" || f.start.frame === null) return { finger: IDLE, send: [] };
  const at = f.start.frame;
  // From the first tap's lift to the second's touch.
  const double = f.lastTap !== undefined && f.start.t - f.lastTap.t <= DOUBLE_MS && near(f.start.at, f.lastTap.at, DOUBLE_NEAR);
  const n = double ? 2 : 1;
  return { finger: double ? IDLE : { t: "idle", lastTap: touch }, send: [mouse("pressed", at, n), mouse("released", at, n)] };
};

/** The touch was taken away (a second finger came for a pinch, the view closed): a press held is let go. */
export const fingerCancel = (f: Finger): Step => (f.t === "holding" ? { finger: IDLE, send: [mouse("released", f.last)] } : { finger: IDLE, send: [] });

// ---- typing: the phone's keyboard into a hidden field, each change sent to the page ----

const key = (k: string): BrowserInput[] => [
  { kind: "key", action: "down", key: k, code: k },
  { kind: "key", action: "up", key: k, code: k },
];

/**
 * What the hidden field took (a key, a paste, a dictated phrase, an autofilled code) for the page, as text; the field
 * is then emptied, so it only ever holds what came since.
 */
export const typed = (next: string): BrowserInput[] => {
  // Up to the hub's 10,000 characters a text.
  const added = next.slice(0, 10_000);
  return added === "" ? [] : [{ kind: "text", text: added }];
};

/** The keyboard's delete: the empty field changes nothing, so its key press says it. */
export const BACKSPACE: readonly BrowserInput[] = key("Backspace");

/** Return on the keyboard: Enter for the page. */
export const ENTER: readonly BrowserInput[] = key("Enter");

// ---- frames: the newest drawn at most so often, the last one always ----

/** The most frames a second the phone draws: a page's screencast can send 25, more than a phone needs to follow it. */
export const MAX_FPS = 12;

/**
 * Paces the frames drawn: one at once, then at most one each `gapMs`, always the newest, and the last of a burst once
 * its gap is up (a page that stops changing shows how it ended). `later` and `cancel` are timers, faked in tests.
 */
export class FramePacer<T> {
  readonly #show: (frame: T) => void;
  readonly #gapMs: number;
  readonly #now: () => number;
  readonly #later: (run: () => void, ms: number) => unknown;
  readonly #cancel: (timer: unknown) => void;
  #shownAt = -Infinity;
  #pending: T | undefined;
  #timer: unknown;

  constructor(show: (frame: T) => void, options: { gapMs?: number; now?: () => number; later?: (run: () => void, ms: number) => unknown; cancel?: (timer: unknown) => void } = {}) {
    this.#show = show;
    this.#gapMs = options.gapMs ?? Math.round(1000 / MAX_FPS);
    this.#now = options.now ?? Date.now;
    this.#later = options.later ?? ((run, ms) => setTimeout(run, ms));
    this.#cancel = options.cancel ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  offer(frame: T): void {
    const wait = this.#shownAt + this.#gapMs - this.#now();
    if (wait <= 0 && this.#timer === undefined) return this.#draw(frame);
    this.#pending = frame;
    this.#timer ??= this.#later(() => {
      this.#timer = undefined;
      const next = this.#pending;
      this.#pending = undefined;
      if (next !== undefined) this.#draw(next);
    }, Math.max(0, wait));
  }

  stop(): void {
    if (this.#timer !== undefined) this.#cancel(this.#timer);
    this.#timer = undefined;
    this.#pending = undefined;
  }

  #draw(frame: T): void {
    this.#shownAt = this.#now();
    this.#show(frame);
  }
}

// ---- New Screen: a screen of the person's own, for a project or a Navi ----

/** The hub feature that says it opens people's screens (`screen_open`): without it, New Screen isn't offered. */
export const NEW_SCREEN = "screen_open";

/** A person's wait for a screen of their own (browser_sessions' `waits`, the hub's ScreenWait), as New Screen follows it. */
export interface Wait {
  readonly waitId: string;
  readonly stage?: string | undefined;
  readonly ahead?: number | undefined;
  readonly threadId?: string | undefined;
  readonly error?: string | undefined;
}

/**
 * Where a wait is, once its project's screens are read again: still waiting (its place in line), failed (why), or
 * opened (its screen, live and the person's: the one on the thread the wait named, else the newest opened since it
 * began).
 */
export const waitOutcome = (
  read: { readonly sessions: readonly BrowserSession[]; readonly waits?: readonly Wait[] | undefined },
  wait: Wait,
  since: string,
): { readonly t: "waiting"; readonly wait: Wait } | { readonly t: "failed"; readonly error: string } | { readonly t: "opened"; readonly sessionId: string } | { readonly t: "gone" } => {
  const now = read.waits?.find((w) => w.waitId === wait.waitId);
  if (now !== undefined) return now.stage === "failed" ? { t: "failed", error: now.error ?? "It didn't open." } : { t: "waiting", wait: now };
  const mine = read.sessions.filter((s) => s.state === "live" && s.openedBy !== undefined);
  const opened = wait.threadId === undefined ? mine.find((s) => s.startedAt >= since) : mine.find((s) => s.threadId === wait.threadId);
  return opened === undefined ? { t: "gone" } : { t: "opened", sessionId: opened.sessionId };
};

/** A wait in words, under New Screen's button. */
export const waitLine = (w: Wait, machine: string): string => {
  if (w.stage === "starting" || w.stage === "installing") return `Starting it on ${machine}…`;
  const ahead = w.ahead ?? 0;
  return ahead === 0 ? `Waiting for a slot on ${machine}: you're next.` : `Waiting for a slot on ${machine}: ${String(ahead)} ${ahead === 1 ? "person" : "people"} ahead of you.`;
};
