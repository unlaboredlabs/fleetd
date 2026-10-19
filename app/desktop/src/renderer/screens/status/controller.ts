// Runs session.ts's effects against the hub. ONE controller per window: the hub keeps one status_wait per
// connection and a new one supersedes the old, so two Status views on one link would cancel each other's waits.

import type { CallOutcome, HubEvent } from "../../../shared/hub";
import type { StatusScope } from "./contracts";
import { initial, reduce, WAIT_DEADLINE_MS, type Action, type Effect, type StatusSession } from "./session";

export interface StatusHub {
  call(tool: string, input: unknown, options: { timeoutMs: number }): Promise<CallOutcome>;
  /** Calls back with the current link state at once, then on every change. Returns the unsubscribe. */
  onLink(listener: (up: boolean) => void): () => void;
}

export interface Timers {
  now(): number;
  set(fn: () => void, ms: number): () => void;
}

const realTimers: Timers = {
  now: () => Date.now(),
  set: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

// Main's own call timeout sits past the view's deadline, so the view notices a lost wait first and main's late
// "timeout" answer is dropped by generation.
const CALL_TIMEOUT_MS = { status_get: 30_000, status_wait: WAIT_DEADLINE_MS + 5_000, status_seen: 30_000 } as const;

export class StatusController {
  #state: StatusSession = initial;
  readonly #listeners = new Set<() => void>();
  #cancelDeadline: (() => void) | null = null;
  #unlink: (() => void) | null = null;

  constructor(
    private readonly hub: StatusHub,
    private readonly timers: Timers = realTimers,
  ) {}

  get state(): StatusSession {
    return this.#state;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  open(scope: StatusScope): void {
    // The link is followed only while a view is open; the first callback says whether it is up.
    this.#unlink ??= this.hub.onLink((up) => this.#dispatch({ t: "link", up }));
    this.#dispatch({ t: "open", scope });
  }

  close(looked: boolean): void {
    this.#dispatch({ t: "close", looked });
    this.#unlink?.();
    this.#unlink = null;
  }

  retry(): void {
    this.#dispatch({ t: "retry" });
  }

  #dispatch(action: Action): void {
    const before = this.#state;
    const [next, effects] = reduce(before, action, this.timers.now());
    this.#state = next;
    if (next.waitDeadline !== before.waitDeadline || next.generation !== before.generation) this.#armDeadline(next);
    for (const effect of effects) this.#run(effect);
    if (next !== before) for (const listener of this.#listeners) listener();
  }

  /** One timer, for the one outstanding wait. Nothing else ticks. */
  #armDeadline(s: StatusSession): void {
    this.#cancelDeadline?.();
    this.#cancelDeadline = null;
    if (s.waitDeadline === null) return;
    const generation = s.generation;
    this.#cancelDeadline = this.timers.set(
      () => this.#dispatch({ t: "deadline", generation }),
      Math.max(0, s.waitDeadline - this.timers.now()),
    );
  }

  #run({ call, generation }: Effect): void {
    const pending = this.hub.call(call.tool, call.input, { timeoutMs: CALL_TIMEOUT_MS[call.tool] });
    if (call.tool === "status_seen") return; // fire and forget: a missed mark only means a longer "since" next time
    const tool = call.tool;
    void pending.then((outcome) =>
      this.#dispatch({
        t: "answer",
        tool,
        generation,
        outcome: outcome.ok ? outcome : { ok: false, message: outcome.error.message },
      }),
    );
  }
}

/** The window's link and event stream, from one subscription made the first time it's needed. A preload subscribe
 * asks main for a fresh snapshot, so this subscribes once per window, not per view. */
const listenersUp = new Set<(up: boolean) => void>();
const listenersEvent = new Set<(event: HubEvent) => void>();
let linkUp = false;
let subscribed = false;

const ensureSubscribed = (): void => {
  if (subscribed) return;
  subscribed = true;
  window.fleetd.hub.subscribe((frame) => {
    if (frame.t === "state") {
      const up = frame.state.phase === "live";
      if (up === linkUp) return;
      linkUp = up;
      for (const listener of listenersUp) listener(up);
    } else if (frame.t === "event") {
      for (const listener of listenersEvent) listener(frame.event);
    }
  });
};

export const windowHub: StatusHub = {
  call: (tool, input, options) => window.fleetd.hub.call(tool, input, options),
  onLink: (listener) => {
    ensureSubscribed();
    listenersUp.add(listener);
    listener(linkUp);
    return () => listenersUp.delete(listener);
  },
};

export const onHubEvent = (listener: (event: HubEvent) => void): (() => void) => {
  ensureSubscribed();
  listenersEvent.add(listener);
  return () => listenersEvent.delete(listener);
};

let shared: StatusController | null = null;
export const statusController = (): StatusController => (shared ??= new StatusController(windowHub));
