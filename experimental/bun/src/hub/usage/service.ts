// The usage layer (crates/fleetd/src/hub/usage/service.rs). A lead or task thread that hits a usage limit is parked
// and sent one "continue" at its reset, leads first, then reviews, then writers. When one login fails the same way on
// two threads within 10 minutes (or its proxy has no account at all), a breaker pauses new turns there with one
// usage.breaker event, until the reset or usage_resume. A limit that names no reset is tried on one parked thread
// after 1, 2, 5, 10 and then every 15 minutes, and the pause lifts once that thread's turn completes. Any turn that
// completes on the login after such a limit lifts it at once. The state is rebuilt from the event log at start.
import type { Clock } from "../../shared/clock.ts";
import type {
  HubEvent,
  HubEventType,
  LoginKind,
  UsageAccount,
  UsageBreaker,
  UsageStatus,
} from "../../shared/contracts.ts";
import { accountFromKey } from "../claude_accounts/index.ts";
import { BATCH_MS, type NewEvent, type WaitInput, type WaitResult } from "../store/events.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { limitOfEvent, type UsageParked } from "./classify.ts";
import {
  type MachineUsage,
  type Owner,
  type ParkedThread,
  type Resumed,
  resumedEvent,
  splitLogin,
  type ThreadKey,
  UsageState,
  loginKey,
} from "./state.ts";

const REPLAYED: HubEventType[] = [
  "thread.usage_limited",
  "thread.started",
  "thread.completed",
  "thread.failed",
  "thread.interrupted",
  "usage.breaker",
  "usage.resumed",
];
const FOLLOWED: HubEventType[] = [
  "thread.usage_limited",
  "thread.started",
  "thread.completed",
  "thread.failed",
  "thread.interrupted",
];

/** The hub's event log as the usage layer uses it (src/hub/store/events.ts `EventLog`). */
export type UsageLog = {
  append(event: NewEvent): HubEvent;
  head(): number;
  wait(input: WaitInput, signal?: AbortSignal): Promise<WaitResult>;
};

export type UsageDeps = {
  events: UsageLog;
  /** The write queue's send of the `usage.continue` prompt, delivered once per `clientMessageId`. Throws when not. */
  sendContinue(thread: ThreadKey, clientMessageId: string): Promise<void>;
  /** A task's thread (with its kind and id) or a lead's current thread; undefined for any other thread. */
  ownerOf(thread: ThreadKey): Owner | undefined;
  /** The task has not ended or been cancelled; for a lead, the thread is still its current one. */
  stillParked(parked: ParkedThread): boolean;
  /** The Claude account the thread was launched on, by key (`hub`, a person's id); none for the machine's own login. */
  accountOf(thread: ThreadKey): string | undefined;
  clock: Clock;
  /** Resolves after `ms` (the hub's: a timer that stops with the hub; tests move a manual clock). */
  sleep(ms: number): Promise<void>;
};

/** A login's breaker as usage_status shows it. Keys in the Rust struct's order. */
function breakerView(m: MachineUsage | undefined): UsageBreaker {
  const b = m?.breaker;
  if (!b) return { state: "closed" };
  const view: Record<string, unknown> = { state: "open", class: b.class, since: b.since };
  if (b.until !== undefined) view.until = b.until;
  if (b.checkAt !== undefined) view.checkAt = b.checkAt;
  if (b.proxy) view.proxy = true;
  view.message = b.message;
  return view as UsageBreaker;
}

/** The machine's login, as its runner reports it: a failure (offline) reads as unknown. */
export type Reading = { login: LoginKind } | { error: string };

export class Usage {
  private readonly state = new UsageState();
  /** The follower's cursor; the op lock serialises the follower, `drain`, resets and `resume`. */
  private cursor = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: UsageDeps) {}

  /** Runs `fn` under the op lock, after every op queued before it. */
  private op<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private nowMs(): number {
    return this.deps.clock.now();
  }

  /**
   * Replays the log, schedules every pending reset, then follows the log from where the replay stopped, until
   * `signal` aborts. `drain`, `status` and `resume` wait for the replay.
   */
  async serve(signal: AbortSignal): Promise<void> {
    await this.op(async () => {
      let cursor = 0;
      let since = performance.now();
      for (;;) {
        const page = await this.deps.events.wait({ cursor, types: REPLAYED, timeoutSec: 0 });
        for (const event of page.events) this.apply(event);
        cursor = page.cursor;
        if (!page.more) break;
        // A long log replays a batch at a time, the hub serving between them; reads meanwhile see the replay so far,
        // as the Rust replay's do.
        if (performance.now() - since >= BATCH_MS) {
          await Bun.sleep(0);
          since = performance.now();
        }
      }
      this.cursor = cursor;
      const resets: string[] = [];
      for (const login of this.state.logins()) {
        const b = this.state.machines.get(login)?.breaker;
        if (b?.until !== undefined) resets.push(b.until);
        if (b?.checkAt !== undefined) resets.push(b.checkAt);
      }
      for (const p of this.state.allParked()) {
        if (p.parked.resumeAt !== undefined) resets.push(p.parked.resumeAt);
        if (p.parked.checkAt !== undefined) resets.push(p.parked.checkAt);
      }
      for (const at of resets) this.schedule(at);
    });
    while (!signal.aborted) {
      try {
        await this.deps.events.wait({ cursor: this.cursor, types: FOLLOWED, timeoutSec: 3600 }, signal);
        if (signal.aborted) return;
        await this.drain();
      } catch (error) {
        console.warn("usage: following the event log failed:", error);
        await this.deps.sleep(1000);
      }
    }
  }

  private accountOfEvent(event: HubEvent): string | undefined {
    if (event.machineId === undefined || event.threadId === undefined) return undefined;
    return this.deps.accountOf({ machineId: event.machineId, threadId: event.threadId });
  }

  private apply(event: HubEvent): void {
    const account = this.accountOfEvent(event);
    const owner =
      event.type === "thread.usage_limited" &&
      event.machineId !== undefined &&
      event.threadId !== undefined &&
      limitOfEvent(event) !== undefined
        ? this.deps.ownerOf({ machineId: event.machineId, threadId: event.threadId })
        : undefined;
    this.state.apply(event, owner, account);
  }

  private emit(event: NewEvent): void {
    this.apply(this.deps.events.append(event));
  }

  /** A tick at `at`. Timers are never cancelled: a tick with nothing due does nothing. */
  private schedule(at: string): void {
    const t = parseMs(at);
    const wait = t === undefined ? 0 : Math.max(t - this.nowMs(), 0);
    void this.deps.sleep(wait).then(
      () => this.op(() => this.tick()),
      () => {},
    );
  }

  /** Resumes whatever is due now: everything a lapsed breaker held, parks past their reset or check, and checks. */
  private async tick(): Promise<void> {
    for (const d of this.state.due(this.nowMs())) {
      if (d.inFlightUntil !== undefined) {
        this.schedule(d.inFlightUntil);
        continue;
      }
      if (d.check && !d.breakerCleared) {
        await this.check(d.machineId, d.threads);
        continue;
      }
      const by = d.check || d.threads.some((p) => p.parked.resumeAt === undefined) ? "check" : "reset";
      // A thread still limited parks again on its next turn, and onLive schedules its next check then.
      await this.resumeThreads(d.machineId, d.threads, d.breakerCleared, by);
    }
  }

  /**
   * A check of a breaker with no reset: sends the first thread still parked "continue" and names it in a
   * usage.resumed `check` event, which keeps the breaker open and sets the next check. With nothing left to try, the
   * breaker clears, and the queue's next turn tries the login itself.
   */
  private async check(login: string, parked: ParkedThread[]): Promise<void> {
    for (const p of UsageState.inOrder(parked)) {
      this.state.take(p.thread);
      const sent = await this.sendContinue(p);
      if (!sent) continue;
      const event = resumedEvent(login, isoMs(this.nowMs()), [sent], false, "check");
      if (event) this.emit(event);
      const next = this.state.machines.get(login)?.breaker?.checkAt;
      if (next !== undefined) this.schedule(next);
      return;
    }
    const event = resumedEvent(login, isoMs(this.nowMs()), [], true, "unchecked");
    if (event) this.emit(event);
  }

  /** Sends one parked thread "continue", unless its task ended or its lead moved on. */
  private async sendContinue(p: ParkedThread): Promise<Resumed | undefined> {
    if (!this.deps.stillParked(p)) return undefined;
    // The id names this park, so a resend after a restart is delivered once.
    const id = `fleetd-usage:${p.thread.machineId}/${p.thread.threadId}:${parseMs(p.parked.since) ?? 0}`;
    try {
      await this.deps.sendContinue(p.thread, id);
    } catch (error) {
      console.warn(`usage: continue not delivered to ${p.thread.machineId}/${p.thread.threadId}:`, error);
      return undefined;
    }
    return { threadId: p.thread.threadId, kind: p.kind, ...(p.taskId !== undefined ? { taskId: p.taskId } : {}) };
  }

  /** Sends "continue" in priority order and reports it in one usage.resumed event. Returns how many went out. */
  private async resumeThreads(login: string, list: ParkedThread[], breakerCleared: boolean, by: string): Promise<number> {
    const sent: Resumed[] = [];
    for (const p of this.state.takeInOrder(list)) {
      const r = await this.sendContinue(p);
      if (r) sent.push(r);
    }
    const event = resumedEvent(login, isoMs(this.nowMs()), sent, breakerCleared, by);
    if (event) this.emit(event);
    return sent.length;
  }

  private async onLive(event: HubEvent): Promise<void> {
    const account = this.accountOfEvent(event);
    const lifted = this.state.liftedBy(event, account);
    this.apply(event);
    if (lifted) {
      await this.resumeThreads(lifted.machineId, lifted.threads, lifted.breakerCleared, "turn");
      return;
    }
    if (event.type !== "thread.usage_limited" || event.machineId === undefined) return;
    const machineId = event.machineId;
    const login = loginKey(machineId, account);
    const trip = this.state.trip(login, isoMs(this.nowMs()));
    if (trip) {
      this.emit(trip[0]);
      if (trip[1] !== undefined) this.schedule(trip[1]);
    }
    const resumeAt = limitOfEvent(event)?.resumeAt;
    if (resumeAt !== undefined) this.schedule(resumeAt);
    const checkAt =
      event.threadId === undefined ? undefined : this.state.parked({ machineId, threadId: event.threadId })?.checkAt;
    if (checkAt !== undefined) this.schedule(checkAt);
    const breakerCheck = this.state.machines.get(login)?.breaker?.checkAt;
    if (breakerCheck !== undefined) this.schedule(breakerCheck);
  }

  /** Applies every followed event appended so far. The caller holds the op lock. */
  private async pump(): Promise<void> {
    for (;;) {
      const page = await this.deps.events.wait({ cursor: this.cursor, types: FOLLOWED, timeoutSec: 0 });
      for (const event of page.events) await this.onLive(event);
      this.cursor = page.cursor;
      if (!page.more) return;
    }
  }

  /** Applies the thread events appended so far, so a read right after them sees their effect. */
  drain(): Promise<void> {
    return this.op(() => this.pump());
  }

  /** Why a new turn may not start on the machine's own login now, as a queued reason ("usage: paused until …"). */
  gate(machineId: string): string | undefined {
    return this.gateFor(machineId, undefined);
  }

  /** `gate` for one Claude account on the machine (by key), or its own login with none. */
  gateFor(machineId: string, account: string | undefined): string | undefined {
    return this.state.gate(loginKey(machineId, account), this.nowMs());
  }

  /** `gate` of the thread's own login, or why this thread is parked. Lead wakes wait while it is set. */
  hold(thread: ThreadKey): string | undefined {
    return this.state.hold(thread, this.deps.accountOf(thread), this.nowMs());
  }

  parkedOf(thread: ThreadKey): UsageParked | undefined {
    const p = this.state.parked(thread);
    return p && { ...p };
  }

  /** Returns once `hold` is clear for the thread, or `signal` aborts. */
  async whenClear(thread: ThreadKey, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const head = this.deps.events.head();
      if (this.hold(thread) === undefined) return;
      await this.deps.events.wait(
        { cursor: head, types: ["usage.resumed", "thread.started"], machineId: thread.machineId, timeoutSec: 3600 },
        signal,
      );
    }
  }

  /** The machine's usage view; `reading` is its runner's login. `accounts`: each Claude account known there. */
  async status(machineId: string, reading: Reading): Promise<UsageStatus> {
    await this.drain();
    const s = this.state;
    const accounts: UsageAccount[] = [];
    for (const login of s.loginsOf(machineId)) {
      const key = splitLogin(login)[1];
      const account = key === undefined ? undefined : accountFromKey(key);
      if (!account) continue;
      accounts.push({ account, breaker: breakerView(s.machines.get(login)), parked: s.countsOn(login) });
    }
    const m = s.machines.get(machineId);
    // Keys in the Rust struct's order.
    return {
      machineId,
      login: "login" in reading ? reading.login : "unknown",
      breaker: breakerView(m),
      parked: s.countsOn(machineId),
      ...(accounts.length > 0 ? { accounts } : {}),
      lastEvents: m ? [...m.lastEvents] : [],
    };
  }

  /** usage_resume: closes the machine's breakers and sends "continue" to every thread parked there. */
  resume(machineId: string, by: string): Promise<number> {
    return this.op(async () => {
      await this.pump();
      return this.resumeHeld(machineId, by);
    });
  }

  /**
   * A lead's usage_resume: `resume`, unless a lead of any project lifted something on the machine less than
   * `everyMs` ago; then refused with which lead and when (epoch ms). Both under one op lock.
   */
  resumeAsLead(machineId: string, by: string, everyMs: number): Promise<{ resumed: number } | { refused: [string, number] }> {
    return this.op(async () => {
      await this.pump();
      const now = this.nowMs();
      let last: [string, number] | undefined;
      for (const login of this.state.loginsOf(machineId)) {
        for (const [who, at] of this.state.machines.get(login)?.resumedBy ?? []) {
          // A lead's `by` is `lead:<machine>/<project>`.
          if (who.startsWith("lead:") && (!last || at >= last[1])) last = [who, at];
        }
      }
      if (last && now - last[1] < everyMs) return { refused: last };
      return { resumed: await this.resumeHeld(machineId, by) };
    });
  }

  /** `resume`'s work, for the machine's own login and each account's there; the caller holds the op lock. */
  private async resumeHeld(machineId: string, by: string): Promise<number> {
    const logins = this.state.loginsOf(machineId);
    if (!logins.includes(machineId)) logins.unshift(machineId);
    let resumed = 0;
    for (const login of logins) {
      const cleared = this.state.machines.get(login)?.breaker !== undefined;
      resumed += await this.resumeThreads(login, this.state.parkedOn(login), cleared, by);
    }
    return resumed;
  }
}
