// Live view: who watches which browser session, and their frames. A node sends
// a session's frames only while the hub watches it (`browser_watch` on, sent with each new watcher, off after the
// last), and again after a reconnect. The hub keeps no frame: each goes to the app connections watching its session
// as it comes, and a slow one skips frames rather than queueing them. A node answers each `on` with the session's
// newest frame. An app that acks its frames says what its link carries; the node hears the slowest's (`kbps`).
import type { BrowserAction, BrowserControl, BrowserFrame, BrowserInput, BrowserSession } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_BROWSER, type ScreenStep } from "../../shared/screens_wire.ts";
import type { Hub } from "../api/hub.ts";
import { isHuman, requireRole } from "../api/grants.ts";
import type { Caller } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { runnerOf } from "../machine_roles/places.ts";
import { link } from "../link/index.ts";
import { get } from "./store.ts";
import { Thumbs } from "./thumbs.ts";

/** A watched session's budget changes this little, or this soon after the last, go untold. */
const RETELL_SHARE = 0.2;
const RETELL_EVERY = 2_000;

class Budgets {
  /** Each watch's limit, by its id: undefined while its link keeps up. */
  readonly byWatch = new Map<number, number | undefined>();
  told: number | undefined;
  toldAt: number | undefined;

  slowest(): number | undefined {
    let min: number | undefined;
    for (const v of this.byWatch.values()) if (v !== undefined && (min === undefined || v < min)) min = v;
    return min;
  }

  /** The budget to tell the node now, if it should be told (`{ kbps }`): `force` after a watch ends. */
  retell(force: boolean, now: number): { kbps: number | undefined } | undefined {
    const next = this.slowest();
    const moved =
      this.told !== undefined && next !== undefined ? Math.abs(this.told - next) > this.told * RETELL_SHARE : this.told !== next;
    const soon = this.toldAt !== undefined && now - this.toldAt < RETELL_EVERY;
    if (!moved || (soon && !force)) return undefined;
    this.told = next;
    this.toldAt = now;
    return { kbps: next };
  }
}

/** A key asked of the node again this soon after the last for the same screen goes untold: one is on its way. */
const KEY_EVERY = 250;

const watchFrame = (sessionId: string, on: boolean, kbps: number | undefined, video = false, key = false) => ({
  t: "browser_watch" as const,
  sessionId,
  on,
  ...(kbps === undefined ? {} : { kbps }),
  ...(video ? { video: true } : {}),
  ...(key ? { key: true } : {}),
});

/** One app connection's watch of a session; `end()` ends it. */
export class Watch {
  private ended = false;
  constructor(
    private readonly live: Live,
    readonly machine: string,
    readonly session: string,
    readonly id: number,
    readonly onFrame: (frame: BrowserFrame) => void,
    /** Whether it decodes H.264: undefined for either (the Screens page's pictures take a JPEG the node sends first). */
    readonly video: boolean | undefined,
  ) {}

  /** A frame of its was dropped on the way (an H.264 one): the node sends a keyframe next. */
  key(): void {
    if (!this.ended) this.live.key(this.session);
  }

  /** The watch's link carries `kbps` (undefined: it keeps up). */
  budget(kbps: number | undefined): void {
    if (!this.ended) this.live.budget(this, kbps);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.live.unwatch(this);
  }
}

export class Live {
  /** Watched sessions: their machine, and their watches. */
  private readonly watched = new Map<string, { machine: string; watches: Set<Watch> }>();
  /** `browser_control` calls waiting for the node to report who drives a session now. */
  private readonly controls = new Map<string, Set<(control: BrowserControl) => void>>();
  /** When a person last sent input to each session, in the hub clock's ms. */
  private readonly inputs = new Map<string, number>();
  /** Sessions watched with no frame from their node yet, since when. */
  private readonly first = new Map<string, number>();
  /** Each live session's latest step, and the machine whose heartbeat said it. */
  private readonly steps = new Map<string, { machine: string; step: BrowserAction }>();
  private readonly budgets = new Map<string, Budgets>();
  /** When a keyframe was last asked of each session's node. */
  private readonly keyed = new Map<string, number>();
  private ids = 0;
  readonly thumbs = new Thumbs();

  constructor(private readonly hub: Hub) {}

  /** A node's frame, for whoever watches its session. */
  frame(machine: string, frame: BrowserFrame): void {
    const watched = this.watched.get(frame.sessionId);
    if (!watched || watched.machine !== machine) return;
    this.first.delete(frame.sessionId);
    if (frame.jpegB64 !== undefined) this.thumbs.offer(frame);
    for (const w of watched.watches) w.onFrame(frame);
  }

  /**
   * Starts watching `session` on `machine`: its node starts sending frames, and sends its newest again for each (as a
   * JPEG). `video`: the watch decodes H.264; the node sends it only while every watch of the session does.
   */
  watch(machine: string, session: string, onFrame: (frame: BrowserFrame) => void, video?: boolean): Watch {
    let watched = this.watched.get(session);
    if (!watched) {
      watched = { machine, watches: new Set() };
      this.watched.set(session, watched);
      this.first.set(session, performance.now());
    }
    const w = new Watch(this, watched.machine, session, ++this.ids, onFrame, video);
    watched.watches.add(w);
    let b = this.budgets.get(session);
    if (!b) {
      b = new Budgets();
      this.budgets.set(session, b);
    }
    b.byWatch.set(w.id, undefined);
    link(this.hub).send(watched.machine, watchFrame(session, true, b.told, this.video(session)));
    return w;
  }

  /** Whether `session`'s node sends H.264: some watch decodes it, and none can't. */
  private video(session: string): boolean {
    const watches = [...(this.watched.get(session)?.watches ?? [])];
    return watches.some((w) => w.video === true) && !watches.some((w) => w.video === false);
  }

  /** A watch lost an H.264 frame: the node sends a keyframe next, asked once per KEY_EVERY. */
  key(session: string): void {
    const watched = this.watched.get(session);
    if (!watched || !this.video(session)) return;
    const now = performance.now();
    const last = this.keyed.get(session);
    if (last !== undefined && now - last < KEY_EVERY) return;
    this.keyed.set(session, now);
    link(this.hub).send(watched.machine, watchFrame(session, true, this.budgets.get(session)?.told, true, true));
  }

  budget(w: Watch, kbps: number | undefined): void {
    const b = this.budgets.get(w.session);
    if (!b || !b.byWatch.has(w.id) || b.byWatch.get(w.id) === kbps) return;
    b.byWatch.set(w.id, kbps);
    const tell = b.retell(false, performance.now());
    if (tell) this.tell(w.session, tell.kbps);
  }

  private tell(session: string, kbps: number | undefined): void {
    const machine = this.watched.get(session)?.machine;
    if (machine) link(this.hub).send(machine, watchFrame(session, true, kbps, this.video(session)));
  }

  unwatch(w: Watch): void {
    // Its say in the budget goes: the next slowest's is told, or none with the last watch.
    const b = this.budgets.get(w.session);
    if (b) {
      b.byWatch.delete(w.id);
      if (b.byWatch.size === 0) this.budgets.delete(w.session);
      else {
        const tell = b.retell(true, performance.now());
        if (tell) this.tell(w.session, tell.kbps);
      }
    }
    const watched = this.watched.get(w.session);
    const video = this.video(w.session);
    if (!watched || !watched.watches.delete(w)) return;
    if (watched.watches.size === 0) {
      this.watched.delete(w.session);
      this.first.delete(w.session);
      this.keyed.delete(w.session);
      link(this.hub).send(watched.machine, watchFrame(w.session, false, undefined));
    } else if (this.video(w.session) !== video) {
      // The one watch that couldn't decode H.264 left, or the last that could: the node switches.
      link(this.hub).send(watched.machine, watchFrame(w.session, true, this.budgets.get(w.session)?.told, !video));
    }
  }

  /** A node linked (again): the sessions watched there, so it sends their frames. */
  rewatch(machine: string): void {
    for (const [session, w] of this.watched) {
      if (w.machine === machine) link(this.hub).send(machine, watchFrame(session, true, this.budgets.get(session)?.told, this.video(session)));
    }
  }

  /** Calls `fn` with each control the node reports for `session` from now on, until the returned stop. */
  awaitControl(session: string, fn: (control: BrowserControl) => void): () => void {
    let set = this.controls.get(session);
    if (!set) {
      set = new Set();
      this.controls.set(session, set);
    }
    set.add(fn);
    return () => {
      const s = this.controls.get(session);
      s?.delete(fn);
      if (s && s.size === 0) this.controls.delete(session);
    };
  }

  awaiting(session: string): number {
    return this.controls.get(session)?.size ?? 0;
  }

  /** The node reported who drives `session`: for the calls waiting on it. */
  controlReported(session: string, control: BrowserControl): void {
    for (const fn of [...(this.controls.get(session) ?? [])]) fn(control);
  }

  noteInput(session: string, at: number): void {
    this.inputs.set(session, at);
  }
  lastInput(session: string): number | undefined {
    return this.inputs.get(session);
  }
  forgetInput(session: string): void {
    this.inputs.delete(session);
  }

  /** A node's heartbeat named the latest step of each session live there: in place of all it said before. */
  stepsReported(machine: string, steps: ScreenStep[]): void {
    for (const [id, s] of this.steps) if (s.machine === machine) this.steps.delete(id);
    for (const s of steps) this.steps.set(s.sessionId, { machine, step: s.step });
  }

  step(session: string): BrowserAction | undefined {
    return this.steps.get(session)?.step;
  }

  watchers(session: string): number {
    return this.watched.get(session)?.watches.size ?? 0;
  }
}

export const live = (hub: Hub) => hub.area("browser.live", (h) => new Live(h));

const noSession = (id: string) =>
  new ToolError("not_found", `No screen ${id}.`, "Call browser_sessions for the bot's screens.");

/** The machine a session runs on: the one hosting it for an agent elsewhere, else its agent's (its project's). */
export const runsOn = (hub: Hub, s: BrowserSession) => runnerOf(hub.db.conn, s.sessionId) ?? s.projectRef.machineId;

/** The app's `browser_watch` of a live session: any key that can read its project's machine. */
export function startWatch(hub: Hub, caller: Caller, id: string, onFrame: (frame: BrowserFrame) => void, video = false): Watch {
  const s = get(hub, id);
  if (!s || !allows(caller, "read", s.projectRef.machineId)) throw noSession(id);
  if (s.state !== "live") {
    throw new ToolError(
      "invalid",
      `Screen ${id} is ${s.state}: replay its recording instead.`,
      "Read its files with browser_recording_get.",
    );
  }
  const machine = runsOn(hub, s);
  if (!link(hub).can(machine, CAP_BROWSER)) {
    throw new ToolError("machine_offline", `${machine}'s node isn't connected, or is too old for live view.`);
  }
  return live(hub).watch(machine, id, onFrame, video);
}

/** The app's `browser_input`: a person's device with operate on the machine, on a session they took over. */
export function input(hub: Hub, caller: Caller, id: string, input: BrowserInput): void {
  const s = get(hub, id);
  const machine = s?.projectRef.machineId;
  if (!s || !machine || !allows(caller, "read", machine)) throw noSession(id);
  if (!isHuman(caller)) {
    throw new ToolError("forbidden", "Only a person's device drives a screen.", "Use the fleetd app, on a computer or a phone.");
  }
  requireRole(caller, "operate", machine);
  if (s.state !== "live" || s.control !== "human") {
    throw new ToolError(
      "invalid",
      `Screen ${id} isn't yours to drive: its agent has control.`,
      "Take it over first with browser_control control human.",
    );
  }
  const runner = runsOn(hub, s);
  live(hub).noteInput(id, hub.clock.now());
  if (!link(hub).send(runner, { t: "browser_input", sessionId: id, input })) {
    throw new ToolError("machine_offline", `${runner}'s node isn't connected.`);
  }
}
