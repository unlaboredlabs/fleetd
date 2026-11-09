// What keeps the built-in avatars alive on the desktop (shared/botAvatar.ts): one conductor for every small one on
// screen, which gives a single avatar an idle moment every 2 to 5 s, never the same one twice running; and each large
// one's own life, planned a few seconds ahead. A moment draws frames only while its springs move: one
// requestAnimationFrame loop writes the poses of the avatars in motion, and stops when they are still. Nothing moves
// while the window is hidden, for an avatar off screen, or with reduced motion.
import { Life, listMoment, listRest, matrixAttr, motionAt, Plan, pose, random, type Moves } from "../../../shared/botAvatar";

export interface Living {
  readonly svg: SVGSVGElement;
  /** drawnFace as pose takes it. */
  readonly parts: readonly number[];
  readonly canBlink: boolean;
  readonly large: boolean;
}

interface Member extends Living {
  readonly plan: Plan;
  /** Its moving elements, in pose's order (their data-pose). */
  readonly nodes: readonly Element[];
  moves: Moves;
  until: number;
  life?: Life;
}

const now = (): number => performance.now() / 1000;
const reduced = (): boolean => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const members = new Set<Member>();
const r = random(Math.floor(Math.random() * 2 ** 31));
let conductor: number | undefined;
let large: number | undefined;
let frame: number | undefined;
let last: Member | undefined;

const onScreen = (m: Member): boolean => {
  if (!m.svg.isConnected) return false;
  const box = m.svg.getBoundingClientRect();
  return box.width > 0 && box.bottom > 0 && box.right > 0 && box.top < window.innerHeight && box.left < window.innerWidth;
};

const awake = (): boolean => document.visibilityState === "visible" && !reduced();

const draw = (m: Member, t: number): void => {
  const mats = pose(m.parts, motionAt(m.moves, t));
  mats.forEach((mat, i) => m.nodes[i]?.setAttribute("transform", matrixAttr(mat)));
};

const tick = (): void => {
  frame = undefined;
  const t = now();
  let moving = false;
  for (const m of members) {
    if (m.until < t - 0.05) continue;
    draw(m, t);
    moving ||= m.until >= t;
  }
  if (moving) frame = requestAnimationFrame(tick);
};

const play = (m: Member): void => {
  const t = now();
  m.plan.settle(t);
  m.moves = m.plan.flat;
  m.until = m.plan.until;
  frame ??= requestAnimationFrame(tick);
};

/** The next small avatar's moment, then the rest before the one after. */
const conduct = (): void => {
  conductor = window.setTimeout(conduct, listRest(r) * 1000);
  if (!awake()) return;
  const shown = [...members].filter((m) => !m.large && m !== last && onScreen(m));
  const m = shown[Math.floor(r() * shown.length)];
  if (m === undefined) return;
  last = m;
  listMoment(m.plan, r, now() + 0.02, m.canBlink);
  play(m);
};

/** Each large avatar's next few seconds. */
const live = (): void => {
  if (!awake()) return;
  const t = now();
  for (const m of members) {
    if (m.life === undefined || !onScreen(m)) continue;
    m.life.ahead(t + 6);
    play(m);
  }
};

const start = (): void => {
  conductor ??= window.setTimeout(conduct, (0.8 + r()) * 1000);
  large ??= window.setInterval(live, 3000);
};

const stop = (): void => {
  window.clearTimeout(conductor);
  window.clearInterval(large);
  if (frame !== undefined) cancelAnimationFrame(frame);
  conductor = large = frame = undefined;
};

/** Brings an avatar to life until the returned function lets it go. */
export const bringToLife = (a: Living): (() => void) => {
  const nodes: Element[] = [];
  for (const el of a.svg.querySelectorAll("[data-pose]")) nodes[Number(el.getAttribute("data-pose"))] = el;
  const m: Member = { ...a, plan: new Plan(), nodes, moves: [0, 0, 0, 0, 0], until: -Infinity };
  if (a.large) {
    m.life = new Life(m.plan, Math.floor(r() * 2 ** 31), now(), a.canBlink);
    m.life.ahead(now() + 6);
    if (awake()) play(m);
  }
  members.add(m);
  start();
  return () => {
    members.delete(m);
    if (last === m) last = undefined;
    if (members.size === 0) stop();
  };
};
