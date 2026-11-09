// What keeps the bots alive on the phone, as on the desktop (its ui/lib/botLife.ts): a bot's springs run on the UI
// thread (Being.tsx), and this says when. A bot in a live state (thinking, working, needs you, done, an error), or a
// large one on its own, moves while it's on screen; an idle one in a list sleeps, and one conductor gives a single idle
// bot on screen its moment (a blink or a glance) every 1.6 to 3.6 s, never the same one twice running. A state change
// wakes a bot while its springs settle. Nothing moves while the app is in the background, for a bot off screen or
// under another screen, or with Reduce Motion once its change has settled; a sleeping bot's clock stops, so it wakes
// where it was.
import { AppState } from "react-native";
import { listRest, random } from "../desktop";

export interface Living {
  /** It lives on its own (a large one), even idle. */
  readonly solo: boolean;
  /** Its state is idle now. */
  idle(): boolean;
  /** Reduce Motion is on. */
  calm(): boolean;
  /** Whether it is on screen now. */
  visible(): Promise<boolean>;
  /** Gives it its moment, on the UI thread. */
  moment(): void;
  /** Runs its springs, or stops them. */
  run(on: boolean): void;
}

interface Member extends Living {
  /** It keeps moving until then (ms), though asleep: a moment's or a change's springs settling. */
  until: number;
  on: boolean;
}

/** How long a moment or a change keeps a sleeping bot moving: its springs settle in that. */
const SETTLE_MS = 2600;
/** How often a moving bot is looked for on screen. */
const LOOK_MS = 1000;

const members = new Set<Member>();
const r = random(Math.floor(Math.random() * 2 ** 31));
let conductor: ReturnType<typeof setTimeout> | undefined;
let looker: ReturnType<typeof setInterval> | undefined;
let last: Member | undefined;

const active = (): boolean => AppState.currentState === "active";
const live = (m: Member): boolean => !m.calm() && (m.solo || !m.idle());

/** Runs `m` while it should move and is seen, else stops it. */
const update = (m: Member): void => {
  const wants = active() && (live(m) || Date.now() < m.until);
  if (!wants) {
    if (m.on) m.run((m.on = false));
    return;
  }
  void m.visible().then((seen) => {
    if (!members.has(m)) return;
    const on = seen && active() && (live(m) || Date.now() < m.until);
    if (on !== m.on) m.run((m.on = on));
  });
};

/** Keeps `m` moving while its springs settle, then stops it unless it should move on. */
const wake = (m: Member): void => {
  m.until = Date.now() + SETTLE_MS;
  update(m);
  setTimeout(() => members.has(m) && update(m), SETTLE_MS + 50);
};

/** The first of `ms` on screen, in a random order. */
const firstShown = async (ms: Member[]): Promise<Member | undefined> => {
  const order = ms.map((m) => ({ m, k: r() })).sort((a, b) => a.k - b.k);
  for (const { m } of order) if (members.has(m) && (await m.visible())) return m;
  return undefined;
};

/** The next idle list bot's moment, then the rest before the one after. */
const conduct = (): void => {
  conductor = setTimeout(conduct, listRest(r) * 1000);
  if (!active()) return;
  void firstShown([...members].filter((m) => !m.solo && m.idle() && !m.calm() && m !== last)).then((m) => {
    if (m === undefined) return;
    last = m;
    m.moment();
    wake(m);
  });
};

const start = (): void => {
  conductor ??= setTimeout(conduct, (0.8 + r()) * 1000);
  looker ??= setInterval(() => {
    for (const m of members) if (m.on || live(m)) update(m);
  }, LOOK_MS);
};

const stop = (): void => {
  clearTimeout(conductor);
  clearInterval(looker);
  conductor = looker = undefined;
};

export interface Life {
  /** Its state changed: it moves while its springs settle, and on if the new state is live. */
  readonly wake: () => void;
  readonly release: () => void;
}

/** Brings a bot to life until it's released. */
export const bringToLife = (a: Living): Life => {
  const m: Member = { ...a, until: 0, on: false };
  members.add(m);
  start();
  // It starts as it comes on screen, once it has been laid out.
  setTimeout(() => members.has(m) && update(m), 50);
  return {
    wake: () => members.has(m) && wake(m),
    release: () => {
      members.delete(m);
      if (m.on) m.run((m.on = false));
      if (last === m) last = undefined;
      if (members.size === 0) stop();
    },
  };
};
