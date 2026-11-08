// What keeps the built-in avatars alive on the phone, as on the desktop (its ui/lib/botLife.ts): one conductor for
// every small avatar on screen gives a single one an idle moment every 2 to 5 s, never the same one twice running, and
// each large one lives on its own, planned a few seconds ahead. The moves are planned here and handed to the avatar
// (Being.tsx), whose springs then run on the UI thread. Nothing moves while the app is in the background, for an
// avatar off screen or under another screen; with Reduce Motion an avatar never joins.
import { AppState } from "react-native";
import { Life, listMoment, listRest, Plan, random, type Moves } from "../desktop";

export interface Living {
  readonly canBlink: boolean;
  readonly large: boolean;
  /** Runs its moves until they come to rest at `until`, from now. */
  play(moves: Moves, from: number, until: number): void;
  /** Whether it is on screen now. */
  visible(): Promise<boolean>;
}

interface Member extends Living {
  readonly plan: Plan;
  life?: Life;
}

/** Seconds, on the clock the moves are planned on. */
export const now = (): number => performance.now() / 1000;

const members = new Set<Member>();
const r = random(Math.floor(Math.random() * 2 ** 31));
let conductor: ReturnType<typeof setTimeout> | undefined;
let large: ReturnType<typeof setInterval> | undefined;
let last: Member | undefined;

const awake = (): boolean => AppState.currentState === "active";

const play = (m: Member): void => {
  const t = now();
  m.plan.settle(t);
  m.play(m.plan.flat, t, m.plan.until);
};

/** The first of `ms` on screen, in a random order. */
const firstShown = async (ms: Member[]): Promise<Member | undefined> => {
  const order = ms.map((m) => ({ m, k: r() })).sort((a, b) => a.k - b.k);
  for (const { m } of order) if (members.has(m) && (await m.visible())) return m;
  return undefined;
};

/** The next small avatar's moment, then the rest before the one after. */
const conduct = (): void => {
  conductor = setTimeout(conduct, listRest(r) * 1000);
  if (!awake()) return;
  void firstShown([...members].filter((m) => !m.large && m !== last)).then((m) => {
    if (m === undefined) return;
    last = m;
    listMoment(m.plan, r, now() + 0.02, m.canBlink);
    play(m);
  });
};

/** Each large avatar's next few seconds. */
const live = (m: Member): void => {
  void m.visible().then((shown) => {
    if (!shown || !awake() || m.life === undefined || !members.has(m)) return;
    m.life.ahead(now() + 6);
    play(m);
  });
};

const start = (): void => {
  conductor ??= setTimeout(conduct, (0.8 + r()) * 1000);
  large ??= setInterval(() => {
    for (const m of members) if (m.life !== undefined) live(m);
  }, 3000);
};

const stop = (): void => {
  clearTimeout(conductor);
  clearInterval(large);
  conductor = large = undefined;
};

/** Brings an avatar to life until the returned function lets it go. */
export const bringToLife = (a: Living): (() => void) => {
  const m: Member = { ...a, plan: new Plan() };
  if (a.large) m.life = new Life(m.plan, Math.floor(r() * 2 ** 31), now(), a.canBlink);
  members.add(m);
  start();
  // A large one starts as it comes on screen, once it has been laid out.
  if (m.life !== undefined) setTimeout(() => live(m), 50);
  return () => {
    members.delete(m);
    if (last === m) last = undefined;
    if (members.size === 0) stop();
  };
};
