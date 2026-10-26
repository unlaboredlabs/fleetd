// The design preview of try it yourself (W58, docs/design/try-it.md), until the hub runs previews: storefront's #14,
// which a person starts on the web or on an Android emulator, drives, marks up and signs off. Nothing here starts on
// its own: a run begins only on Try it, and ends on End or after the idle time. Shown only under the `tryit-preview`
// fixture, so no other screen changes. QA sets a state with the `fleetd:tryit` window event (detail: a preset name).
import { useSyncExternalStore } from "react";

export type Target = "web" | "android";
export type Phase = "starting" | "ready" | "ended";

export interface RunStep {
  readonly words: string;
  /** Under the words: what it reused, where it runs. */
  readonly detail?: string;
  /** How long it took, once done. */
  readonly took?: string;
}

export interface Run {
  readonly phase: Phase;
  /** Steps done so far; the next one is at work while starting. */
  readonly done: number;
  readonly startedMs: number;
}

/** A point on the page, and what the person says about it. Coordinates are fractions of the screen. */
export interface Pin {
  readonly n: number;
  readonly target: Target;
  readonly x: number;
  readonly y: number;
  readonly note: string;
  /** What is under the pin, as the page names it ("the button “Pay”"), when the frame could tell. */
  readonly what?: string | undefined;
}

export interface Sent {
  readonly atMs: number;
  readonly text: string;
}

/** The app under test: what the person did in it, so the page and the phone keep their place. */
export interface AppState {
  readonly lang: "de" | "nl";
  readonly screen: "cart" | "pay" | "thanks";
}

export interface TryIt {
  readonly runs: Partial<Record<Target, Run>>;
  readonly target: Target;
  readonly marking: boolean;
  readonly pins: readonly Pin[];
  /** Add the last 30 s of the session's recording to the feedback. */
  readonly clip: boolean;
  readonly sent: Sent | undefined;
  /** The person marked #14 "I want to try this": the train holds it for their sign-off. */
  readonly wantTry: boolean;
  readonly signedOff: boolean;
  readonly web: AppState;
  readonly phone: AppState;
}

export const PREVIEW_PR = { repo: "acme/storefront", number: 14 } as const;
/** storefront, the fixtures' project (fixtures/agents/route.ts). */
export const STOREFRONT = { machineId: "devbox", projectId: "dcffccea-c5a7-40a6-940d-7f70239ffa22" } as const;
export const WRITER = "#14’s writer";
export const MACHINE = "devbox";
export const HEAD = "3f2a91c";
/** The preview's own port on the machine, open to the person's devices on the tailnet only. */
export const URL_WEB = "http://devbox:8414";
export const IDLE_MIN = 30;
const PAY_NL = "the button “Bestelling plaatsen en betalen”";

export const STEPS: Readonly<Record<Target, readonly RunStep[]>> = {
  web: [
    { words: "Check out fleetd/T14-checkout-buttons-de-nl", detail: `at ${HEAD}, in a worktree of its own on ${MACHINE}`, took: "1 s" },
    { words: "Setup: pnpm install", detail: "reused: pnpm-lock.yaml hasn’t changed", took: "0 s" },
    { words: "Build: pnpm build", detail: "the build cache had 212 of 230 modules", took: "41 s" },
    { words: "Start: pnpm preview --port $PORT", detail: "on 127.0.0.1:4173; it answered at /", took: "2 s" },
    { words: "Open to your devices", detail: URL_WEB, took: "" },
  ],
  android: [
    { words: "Build: ./gradlew assembleDebug", detail: `Gradle’s cache, keyed by ${HEAD}`, took: "1 min 12 s" },
    { words: "Emulator: Pixel 8, Android 15", detail: `a fresh snapshot from ${MACHINE}’s pool of 2`, took: "3 s" },
    { words: "Install app-debug.apk", detail: "18.4 MB", took: "6 s" },
    { words: "Open the app at checkout", detail: "acme://checkout?lang=de", took: "" },
  ],
};

/** How long a step takes in the preview. */
const STEP_MS = 900;

const START: TryIt = {
  runs: {},
  target: "web",
  marking: false,
  pins: [],
  clip: true,
  sent: undefined,
  wantTry: false,
  signedOff: false,
  web: { lang: "de", screen: "cart" },
  phone: { lang: "de", screen: "cart" },
};

// A DOM test may have no bridge at all.
export const PREVIEW = typeof window !== "undefined" && "fleetd" in window && window.fleetd.fixture === "tryit-preview";

let state: TryIt = START;
const listeners = new Set<() => void>();
const timers = new Map<Target, ReturnType<typeof setInterval>>();

const set = (next: TryIt): void => {
  state = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useTryIt = (): TryIt => useSyncExternalStore(subscribe, () => state);

const stop = (target: Target): void => {
  const t = timers.get(target);
  if (t !== undefined) clearInterval(t);
  timers.delete(target);
};

const ready = (target: Target): Run => ({ phase: "ready", done: STEPS[target].length, startedMs: Date.now() - 52_000 });

/** Try it: starts the target's run (and only that one), its steps arriving as the node would report them. */
export const start = (target: Target): void => {
  stop(target);
  set({ ...state, target, marking: false, runs: { ...state.runs, [target]: { phase: "starting", done: 0, startedMs: Date.now() } } });
  timers.set(
    target,
    setInterval(() => {
      const run = state.runs[target];
      if (run === undefined || run.phase !== "starting") return stop(target);
      const done = run.done + 1;
      const last = done >= STEPS[target].length - 1;
      set({ ...state, runs: { ...state.runs, [target]: { ...run, done: last ? STEPS[target].length : done, phase: last ? "ready" : "starting" } } });
      if (last) stop(target);
    }, STEP_MS),
  );
};

/** Try it from outside the view (the merge line): reopens a run that is starting or ready, the one on view first, and
 * starts one only when none is. */
export const openOrStart = (): void => {
  const live = (t: Target) => {
    const run = state.runs[t];
    return run !== undefined && run.phase !== "ended";
  };
  const running = live(state.target) ? state.target : (["web", "android"] as const).find(live);
  if (running === undefined) start(state.target);
  else if (running !== state.target) pickTarget(running);
};

/** End: the node throws the run away (process, worktree's port, emulator snapshot). */
export const end = (target: Target): void => {
  stop(target);
  const run = state.runs[target];
  if (run !== undefined) set({ ...state, marking: false, runs: { ...state.runs, [target]: { ...run, phase: "ended" } } });
};

export const pickTarget = (target: Target): void => set({ ...state, target, marking: false });
export const setMarking = (marking: boolean): void => set({ ...state, marking });
export const addPin = (target: Target, x: number, y: number, what?: string): void =>
  set({ ...state, pins: [...state.pins, { n: state.pins.length + 1, target, x, y, note: "", what }] });
export const notePin = (n: number, note: string): void => set({ ...state, pins: state.pins.map((p) => (p.n === n ? { ...p, note } : p)) });
export const dropPin = (n: number): void =>
  set({ ...state, pins: state.pins.filter((p) => p.n !== n).map((p, i) => ({ ...p, n: i + 1 })) });
export const setClip = (clip: boolean): void => set({ ...state, clip });
export const setWantTry = (wantTry: boolean): void => set({ ...state, wantTry, signedOff: wantTry ? state.signedOff : false });
export const signOff = (): void => set({ ...state, signedOff: true });
export const drive = (target: Target, change: Partial<AppState>): void =>
  set(target === "web" ? { ...state, web: { ...state.web, ...change } } : { ...state, phone: { ...state.phone, ...change } });

const where = (t: Target, app: AppState): string =>
  t === "web" ? `/checkout${app.screen === "cart" ? "" : `/${app.screen}`}?lang=${app.lang}` : `the app’s ${app.screen} screen, in ${app.lang === "de" ? "German" : "Dutch"}`;

/** What the agent gets: plain words, each point with where it is, then what's attached. */
export const fixRequest = (s: TryIt): string => {
  const target = s.target;
  const app = target === "web" ? s.web : s.phone;
  const pins = s.pins.filter((p) => p.target === target);
  const lines = [
    `Fix request from the person, who tried #14 on ${target === "web" ? "the web" : "an Android emulator"} at ${HEAD}:`,
    "",
    ...pins.map(
      (p) =>
        `${String(p.n)}. ${p.note.trim() === "" ? "(no words: see the screenshot)" : p.note.trim()}\n   Pin ${String(p.n)}: ${p.what === undefined ? "" : `${p.what}, `}on ${where(target, app)}, ${String(Math.round(p.x * 100))}% across, ${String(Math.round(p.y * 100))}% down.`,
    ),
    "",
    `Attached: screenshot-1.png (the ${target === "web" ? "page" : "screen"} with ${pins.length === 1 ? "its pin" : "its pins"})${s.clip ? ", clip.webm (the last 30 s of the session)" : ""}.`,
    "When it’s fixed, push to the PR: the person tries it again from there.",
  ];
  return lines.join("\n");
};

export const send = (): void => {
  set({ ...state, marking: false, sent: { atMs: Date.now(), text: fixRequest(state) } });
};

const PRESETS: Readonly<Record<string, () => TryIt>> = {
  fresh: () => START,
  web: () => ({ ...START, runs: { web: ready("web") } }),
  "web-nl": () => ({ ...START, runs: { web: ready("web") }, web: { lang: "nl", screen: "cart" } }),
  android: () => ({ ...START, target: "android", runs: { web: ready("web"), android: ready("android") } }),
  marked: () => ({
    ...START,
    runs: { web: ready("web") },
    web: { lang: "nl", screen: "cart" },
    marking: true,
    pins: [{ n: 1, target: "web", x: 0.76, y: 0.76, note: "In Dutch the button wraps onto two lines. Keep it on one, as in German.", what: PAY_NL }],
  }),
  sent: () => {
    const s: TryIt = {
      ...START,
      runs: { web: ready("web") },
      web: { lang: "nl", screen: "cart" },
      pins: [{ n: 1, target: "web", x: 0.76, y: 0.76, note: "In Dutch the button wraps onto two lines. Keep it on one, as in German.", what: PAY_NL }],
    };
    return { ...s, sent: { atMs: Date.now() - 40_000, text: fixRequest(s) } };
  },
  signoff: () => ({ ...START, wantTry: true, runs: { web: { ...ready("web"), phase: "ended" } } }),
};

if (PREVIEW) {
  window.addEventListener("fleetd:tryit", (e) => {
    const preset = PRESETS[String((e as CustomEvent<unknown>).detail)];
    if (preset === undefined) return;
    for (const t of [...timers.keys()]) stop(t);
    set(preset());
  });
}

/** Whether the PR is the preview's (only under its fixture). */
export const isPreviewPr = (repo: string, number: number): boolean => PREVIEW && repo === PREVIEW_PR.repo && number === PREVIEW_PR.number;

export const isPreviewProject = (project: { machineId: string; projectId: string }): boolean =>
  PREVIEW && project.machineId === STOREFRONT.machineId && project.projectId === STOREFRONT.projectId;

/** Open #14's Try it: the PR view takes the tab once it shows (PrDetail), so a button anywhere can lead there. */
let wantTab = false;
export const askTab = (): void => {
  wantTab = true;
  for (const l of listeners) l();
};
export const takeTab = (): boolean => {
  const asked = wantTab;
  wantTab = false;
  return asked;
};
