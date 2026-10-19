// The Status view's link to the hub, as a pure state machine: what shows (skeleton, live, not live) and which calls
// to make. It cannot be stale:
// - opening asks `status_get`, then holds exactly ONE `status_wait` open while the view shows; nothing polls;
// - every wait has a deadline (WAIT_SEC + grace). A wait that misses it was lost on a half-open link (laptop sleep,
//   Wi-Fi switch): the view stops claiming to be live at once and asks again;
// - staleness of hub data is the hub's call (each part's as-of and reason come in the doc); this only knows the link;
// - while the link is down the last doc stays under "Not live"; after a reconnect the view is a skeleton until the
//   hub answers, so a cached number never shows as live;
// - every answer carries the generation it was asked in; a scope switch, close, deadline or reconnect bumps it, so a
//   late answer can't revive old data.
// The controller (controller.ts) runs the effects; the reducer is all the logic, and is what the tests cover.

import { asGetOutput, asWaitOutput, scopeKey, type StatusDoc, type StatusScope } from "./contracts";

/** How long the hub holds a `status_wait` before answering "unchanged". The hub supersedes a connection's previous
 * wait when a new one arrives, so a view that moved on leaves at most one wait behind, for at most this long. */
export const WAIT_SEC = 25;
/** A wait not answered by WAIT_SEC plus this has been lost. */
export const WAIT_GRACE_MS = 10_000;
export const WAIT_DEADLINE_MS = WAIT_SEC * 1000 + WAIT_GRACE_MS;

export type Phase = "closed" | "skeleton" | "live" | "notLive";

export interface StatusSession {
  readonly scope: StatusScope | null;
  readonly doc: StatusDoc | null;
  /** Local clock when `doc` arrived, to carry the hub's `now` forward. */
  readonly receivedMs: number;
  /** `doc` came on the current link and the wait loop holds: what shows is live. */
  readonly fresh: boolean;
  readonly linkUp: boolean;
  /** Why the view is not live, when it's the status calls (not the link) that failed. */
  readonly error: string | null;
  /** The last failure can be retried by hand (a failed answer); a lost wait already asks again on its own. */
  readonly retry: boolean;
  /** Bumped whenever continuity breaks (skeleton, scope switch, not-live gap): the number never tweens across one. */
  readonly session: number;
  readonly generation: number;
  /** Local ms by which the outstanding wait must answer; null when none is out. */
  readonly waitDeadline: number | null;
}

export type Call =
  | { readonly tool: "status_get"; readonly input: { readonly scope: StatusScope } }
  | {
      readonly tool: "status_wait";
      readonly input: { readonly scope: StatusScope; readonly after: number; readonly timeoutSec: number };
    }
  | { readonly tool: "status_seen"; readonly input: { readonly scope: StatusScope; readonly seq: number } };

export interface Effect {
  readonly call: Call;
  /** Answers with another generation are dropped. Seen marks use -1: nothing waits on them. */
  readonly generation: number;
}

export type Action =
  | { readonly t: "open"; readonly scope: StatusScope }
  /** `looked`: on screen with the window focused for long enough to move the since-you-last-looked mark. */
  | { readonly t: "close"; readonly looked: boolean }
  | { readonly t: "link"; readonly up: boolean }
  | {
      readonly t: "answer";
      readonly tool: "status_get" | "status_wait";
      readonly generation: number;
      readonly outcome: { readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly message: string };
    }
  /** The deadline timer for `generation`'s wait fired. */
  | { readonly t: "deadline"; readonly generation: number }
  | { readonly t: "retry" };

export const initial: StatusSession = {
  scope: null,
  doc: null,
  receivedMs: 0,
  fresh: false,
  linkUp: false,
  error: null,
  retry: false,
  session: 0,
  generation: 0,
  waitDeadline: null,
};

export const phase = (s: StatusSession): Phase =>
  s.scope === null ? "closed" : s.doc === null ? "skeleton" : s.fresh ? "live" : "notLive";

/** The hub's clock now: the doc's `now` carried forward by the local time since it arrived. */
export const hubNow = (s: StatusSession, localNowMs: number): number => {
  const at = s.doc ? Date.parse(s.doc.now) : Number.NaN;
  return Number.isNaN(at) ? localNowMs : at + Math.max(0, localNowMs - s.receivedMs);
};

type Step = readonly [StatusSession, readonly Effect[]];

const get = (s: StatusSession): Step =>
  s.scope && s.linkUp ? [s, [{ call: { tool: "status_get", input: { scope: s.scope } }, generation: s.generation }]] : [s, []];

const wait = (s: StatusSession, after: number, nowMs: number): Step => {
  if (!s.scope || !s.linkUp) return [s, []];
  const next = { ...s, waitDeadline: nowMs + WAIT_DEADLINE_MS };
  return [
    next,
    [{ call: { tool: "status_wait", input: { scope: s.scope, after, timeoutSec: WAIT_SEC } }, generation: s.generation }],
  ];
};

/** Back to a skeleton: no numbers until the hub answers again. */
const reset = (s: StatusSession): StatusSession => ({
  ...s,
  doc: null,
  fresh: false,
  error: null,
  retry: false,
  waitDeadline: null,
  session: s.session + 1,
  generation: s.generation + 1,
});

const sameScope = (a: StatusScope | null, b: StatusScope): boolean => a !== null && scopeKey(a) === scopeKey(b);

export const reduce = (s: StatusSession, a: Action, nowMs: number): Step => {
  switch (a.t) {
    case "open":
      if (sameScope(s.scope, a.scope)) return [s, []];
      return get({ ...reset(s), scope: a.scope });

    case "close": {
      const seen: Effect[] =
        a.looked && s.scope && s.doc && s.linkUp
          ? [{ call: { tool: "status_seen", input: { scope: s.scope, seq: s.doc.seq } }, generation: -1 }]
          : [];
      return [{ ...reset(s), scope: null }, seen];
    }

    case "link":
      if (a.up === s.linkUp) return [s, []];
      if (!a.up) {
        // In-flight answers belong to the old connection: drop them, keep the doc greyed under Not live.
        return [{ ...s, linkUp: false, fresh: false, waitDeadline: null, generation: s.generation + 1, session: s.session + 1 }, []];
      }
      return get({ ...reset(s), linkUp: true });

    case "answer": {
      if (a.generation !== s.generation || !s.scope) return [s, []];
      const cleared = a.tool === "status_wait" ? { ...s, waitDeadline: null } : s;
      if (!a.outcome.ok) return [fail(cleared, a.outcome.message, true), []];
      if (a.tool === "status_get") {
        const out = asGetOutput(a.outcome.output);
        if (!out) return [fail(cleared, "the hub's answer didn't match this app's contracts", true), []];
        return accept(cleared, out.doc, nowMs);
      }
      const out = asWaitOutput(a.outcome.output);
      if (!out) return [fail(cleared, "the hub's answer didn't match this app's contracts", true), []];
      if (out.doc) return accept(cleared, out.doc, nowMs);
      // Unchanged within the timeout: hold the next wait from the version shown.
      return wait(cleared, cleared.doc?.version ?? out.version, nowMs);
    }

    case "deadline": {
      if (a.generation !== s.generation || s.waitDeadline === null || nowMs < s.waitDeadline) return [s, []];
      // Lost, not slow: say so now, drop whatever answer may still come, and ask afresh.
      const lost = fail({ ...s, waitDeadline: null, generation: s.generation + 1 }, `the hub hasn't answered for ${WAIT_DEADLINE_MS / 1000}s`, false);
      return get(lost);
    }

    case "retry":
      if (!s.scope) return [s, []];
      return get({ ...s, error: null, retry: false, generation: s.generation + 1, session: s.session + 1 });
  }
};

const fail = (s: StatusSession, message: string, retry: boolean): StatusSession => ({
  ...s,
  fresh: false,
  error: message,
  retry,
  waitDeadline: null,
  // Not live in between: the number must not tween across the gap.
  session: s.fresh ? s.session + 1 : s.session,
});

const accept = (s: StatusSession, doc: StatusDoc, nowMs: number): Step => {
  if (!s.scope || !sameScope(s.scope, doc.scope)) return [fail(s, "the hub answered for another scope", true), []];
  return wait({ ...s, doc, receivedMs: nowMs, fresh: true, error: null, retry: false }, doc.version, nowMs);
};

/** Time on screen with the window focused, for since-you-last-looked: a look counts after LOOK_MS in total. */
export const LOOK_MS = 3000;

export class Looked {
  #since: number | null = null;
  #total = 0;

  set(visible: boolean, nowMs: number): void {
    if (visible && this.#since === null) this.#since = nowMs;
    if (!visible && this.#since !== null) {
      this.#total += nowMs - this.#since;
      this.#since = null;
    }
  }

  /** Ends the look: whether it was long enough to count. */
  take(nowMs: number): boolean {
    this.set(false, nowMs);
    const long = this.#total >= LOOK_MS;
    this.#total = 0;
    return long;
  }
}
