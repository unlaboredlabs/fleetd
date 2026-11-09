// The usage layer's state as a pure fold over the event log: parked threads,
// recent limit hits per login and the breaker. The service (service.ts) feeds it events and acts on what it returns.
import type { ClaudeAccount, HubEvent } from "../../shared/contracts.ts";
import type { LoginLimit } from "../../shared/node_link.ts";
import { accountFromKey, accountKey } from "../claude_accounts/index.ts";
import type { NewEvent } from "../store/events.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { limitOfEvent, parkedOf, type UsageClass, type UsageParked } from "./classify.ts";

export const BREAKER_WINDOW_MS = 10 * 60_000;
/** After a limit that named no reset, fleetd tries the login again: 1, 2, 5, 10, then every 15 minutes. */
export const CHECK_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 900_000] as const;

/** The wait before check `n` (0-based) of a limit with no reset. */
export const checkAfterMs = (n: number): number =>
  CHECK_BACKOFF_MS[Math.min(n, CHECK_BACKOFF_MS.length - 1)] as number;

const LAST_EVENTS = 10;
/** Threads listed in one usage.resumed event; the event stays under the log's 2 KB data limit. */
const RESUMED_LISTED = 30;
/** How long a check waits for the thread it tried to complete or fail before it tries another. */
export const PROBE_WAIT_MS = 15 * 60_000;

export type ParkedKind = "lead" | "review" | "write" | "read";
/** Resume order: leads first, then reviews, then writers. */
const RANK: Record<ParkedKind, number> = { lead: 0, review: 1, write: 2, read: 3 };

export type ThreadKey = { machineId: string; threadId: string };

/** Whose thread a limited one is: a task (with its kind) or a lead. */
export type Owner = { kind: ParkedKind; taskId?: string };

export type ParkedThread = {
  thread: ThreadKey;
  /** The login it hit the limit on (`loginKey`). */
  login: string;
  kind: ParkedKind;
  taskId?: string;
  parked: UsageParked;
};

type Hit = { threadId: string; class: UsageClass; atMs: number; resumeAt?: string; model?: string; proxy: boolean };

/** One parked thread a check sent "continue" to, and what came of it so far. */
export type Probe = { threadId: string; atMs: number; completed: boolean; limited: boolean };

/** Its turn completed and was not limited. A start proves nothing: claude retries a 429 inside the turn. */
const gotThrough = (p: Probe) => p.completed && !p.limited;

export type Breaker = {
  class: UsageClass;
  since: string;
  /** The reset the limits named. */
  until?: string;
  /** No reset named (and not pool_exhausted): when fleetd next tries one parked thread. */
  checkAt?: string;
  /** Checks sent so far, which sets the next one's wait. */
  checks: number;
  /** The thread the latest check sent "continue" to. */
  probe?: Probe;
  model?: string;
  proxy: boolean;
  message: string;
};

export type MachineUsage = {
  /** Limit hits inside the breaker window, one per thread. */
  recent: Hit[];
  breaker?: Breaker;
  lastEvents: HubEvent[];
  /** Per thread, its limits in a row that named no reset since a turn last completed on the login. */
  streaks: Map<string, number>;
  /** Per thread whose turn is running, when it started (ms). */
  started: Map<string, number>;
  /** Per `by` of a usage.resumed, when it last lifted something here (ms). */
  resumedBy: Map<string, number>;
};

const newMachine = (): MachineUsage => ({
  recent: [],
  lastEvents: [],
  streaks: new Map(),
  started: new Map(),
  resumedBy: new Map(),
});

export type ParkedCounts = { leads: number; tasks: number };

/** One login's resume due now, or, for a breaker with no reset, its check. */
export type Due = {
  machineId: string;
  threads: ParkedThread[];
  breakerCleared: boolean;
  /** A check of an open breaker. */
  check: boolean;
  /** A check that found the thread it tried last still in its turn: it comes back at this time. */
  inFlightUntil?: string;
};

/** What a completed turn on a login lifts: the breaker, and the parks it proves over. */
export type Lifted = { machineId: string; threads: ParkedThread[]; breakerCleared: boolean };

const keyOf = (r: ThreadKey) => `${r.machineId}/${r.threadId}`;

/** The login a thread's limits count against: its machine's own (`devbox`), or one Claude account there (`devbox@hub`). */
export const loginKey = (machineId: string, account?: string) => (account !== undefined ? `${machineId}@${account}` : machineId);

/** A login's machine and account. */
export function splitLogin(login: string): [string, string | undefined] {
  const at = login.indexOf("@");
  return at < 0 ? [login, undefined] : [login.slice(0, at), login.slice(at + 1)];
}

/** Where a login's limit was hit: "devbox", "the hub's API key on devbox". */
function place(login: string): string {
  const [machine, account] = splitLogin(login);
  if (account === undefined) return machine;
  if (account === "hub") return `the hub's API key on ${machine}`;
  return `${account}'s subscription on ${machine}`;
}

/** The login itself: "devbox's login", or an account's `place`. */
function loginText(login: string): string {
  const [machine, account] = splitLogin(login);
  return account === undefined ? `${machine}'s login` : place(login);
}

/** The account an event's data names, by its key. */
function accountOfData(data: Record<string, unknown>): string | undefined {
  const a = data.account as ClaudeAccount | undefined;
  if (!a || typeof a !== "object") return undefined;
  if (a.kind === "hub") return "hub";
  if (a.kind === "person" && typeof a.personId === "string") return accountKey(a);
  return undefined;
}

/** `data` with the login's account, when it is one. */
function withAccount(data: Record<string, unknown>, login: string): Record<string, unknown> {
  const key = splitLogin(login)[1];
  const account = key === undefined ? undefined : accountFromKey(key);
  if (account) data.account = account;
  return data;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
/** chrono's "%a %H:%M" in UTC. */
const dayTime = (ms: number) => {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

/** "Tue 09:00 UTC". */
export function resetText(iso: string): string {
  const ms = parseMs(iso);
  return ms === undefined ? "Invalid Date UTC" : `${dayTime(ms)} UTC`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "12 tasks parked", "the lead and 3 tasks parked". */
export function parkedText(counts: ParkedCounts): string {
  const leads = counts.leads === 0 ? undefined : counts.leads === 1 ? "the lead" : plural(counts.leads, "lead");
  const tasks = counts.tasks === 0 && leads !== undefined ? undefined : plural(counts.tasks, "task");
  return `${[leads, tasks].filter((x) => x !== undefined).join(" and ")} parked`;
}

const limitWord = (cls: UsageClass) => (cls === "rate_limit" ? "rate limit" : "usage limit");

/** The usage.breaker notice. */
export function breakerMessage(
  machineId: string,
  cls: UsageClass,
  until: string | undefined,
  model: string | undefined,
  proxy: boolean,
  counts: ParkedCounts,
): string {
  if (cls === "pool_exhausted") {
    return `your proxy has no account available for ${model ?? "the model"}; fleetd paused work on ${place(machineId)} — check your proxy, then run usage_resume`;
  }
  if (until !== undefined) {
    return `The ${limitWord(cls)} was reached on ${loginText(machineId)}; resets ${resetText(until)}; ${parkedText(counts)}`;
  }
  return `${unknownResetText(machineId, cls, proxy)}; checking again shortly; ${parkedText(counts)}`;
}

function unknownResetText(machineId: string, cls: UsageClass, proxy: boolean): string {
  return proxy
    ? `Rate-limited by your proxy on ${place(machineId)}`
    : `The ${limitWord(cls)} was reached on ${loginText(machineId)}`;
}

function gateText(machineId: string, b: Breaker): string {
  const [where, login] = [place(machineId), loginText(machineId)];
  if (b.class !== "pool_exhausted" && b.until !== undefined) {
    return `usage: paused until ${resetText(b.until)} (${limitWord(b.class)} on ${login})`;
  }
  if (b.class !== "pool_exhausted") {
    return b.proxy
      ? `usage: rate-limited by your proxy on ${where}, checking again shortly`
      : `usage: ${limitWord(b.class)} on ${login}, checking again shortly`;
  }
  return `usage: paused until usage_resume (your proxy has no account for ${b.model ?? "the model"})`;
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
/** Rust's String cmp: by UTF-8 bytes, which code points order the same way. */
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class UsageState {
  /** In first-parked order, which breaks priority ties. */
  private parkedList: [string, ParkedThread][] = [];
  /** Per login: a machine's own, or one Claude account on it. Read in key order, as Rust's BTreeMap. */
  readonly machines = new Map<string, MachineUsage>();

  private machine(login: string): MachineUsage {
    let m = this.machines.get(login);
    if (!m) this.machines.set(login, (m = newMachine()));
    return m;
  }

  private static remember(m: MachineUsage, event: HubEvent): void {
    m.lastEvents.push(event);
    if (m.lastEvents.length > LAST_EVENTS) m.lastEvents.splice(0, m.lastEvents.length - LAST_EVENTS);
  }

  private unpark(key: string): void {
    this.parkedList = this.parkedList.filter(([k]) => k !== key);
  }

  /** The logins in key order. */
  logins(): string[] {
    return [...this.machines.keys()].sort(cmpStr);
  }

  /** The threads parked on a login. */
  parkedOn(login: string): ParkedThread[] {
    return this.parkedList.filter(([, p]) => p.login === login).map(([, p]) => p);
  }

  /** The logins of `machineId` the state knows: its own and each account's there. */
  loginsOf(machineId: string): string[] {
    return this.logins().filter((login) => splitLogin(login)[0] === machineId);
  }

  allParked(): ParkedThread[] {
    return this.parkedList.map(([, p]) => p);
  }

  parked(thread: ThreadKey): UsageParked | undefined {
    const key = keyOf(thread);
    return this.parkedList.find(([k]) => k === key)?.[1].parked;
  }

  countsOn(login: string): ParkedCounts {
    const on = this.parkedOn(login);
    const leads = on.filter((p) => p.kind === "lead").length;
    return { leads, tasks: on.length - leads };
  }

  /**
   * Folds one event into the state, for the replay at start and for live events alike. `owner` is whose thread a
   * thread.usage_limited event is about; `account` is the Claude account the event's thread runs on (by key).
   */
  apply(event: HubEvent, owner: Owner | undefined, account: string | undefined): void {
    const machineId = event.machineId;
    if (machineId === undefined) return;
    const data = (event.data ?? {}) as Record<string, unknown>;
    const login =
      event.type === "usage.breaker" || event.type === "usage.resumed"
        ? loginKey(machineId, accountOfData(data))
        : loginKey(machineId, account);
    const atMs = parseMs(event.at) ?? 0;
    switch (event.type) {
      case "thread.usage_limited": {
        const limit = limitOfEvent(event);
        const threadId = event.threadId;
        if (!limit || threadId === undefined) return;
        const thread = { machineId, threadId };
        const m = this.machine(login);
        UsageState.remember(m, event);
        m.started.delete(threadId);
        const b = m.breaker;
        const p = b?.probe;
        if (b && p && p.threadId === threadId && atMs >= p.atMs && !p.limited) {
          // The thread tried is still limited: the next check is a step on from now, never at once.
          p.limited = true;
          const next = atMs + checkAfterMs(b.checks);
          const current = b.checkAt === undefined ? undefined : parseMs(b.checkAt);
          if (current !== undefined && current < next) b.checkAt = isoMs(next);
        }
        // A limit that named no reset is tried again on the backoff, one step further each time.
        let checkAt: string | undefined;
        if (limit.resumeAt === undefined && limit.class !== "pool_exhausted") {
          const streak = m.streaks.get(threadId) ?? 0;
          checkAt = isoMs(atMs + checkAfterMs(streak));
          m.streaks.set(threadId, streak + 1);
        } else {
          m.streaks.delete(threadId);
        }
        m.recent = m.recent.filter((h) => h.threadId !== threadId && h.atMs > atMs - BREAKER_WINDOW_MS);
        const hit: Hit = { threadId, class: limit.class, atMs, proxy: limit.proxy };
        if (limit.resumeAt !== undefined) hit.resumeAt = limit.resumeAt;
        if (limit.model !== undefined) hit.model = limit.model;
        m.recent.push(hit);
        const parked = parkedOf(event);
        if (owner && parked) {
          const key = keyOf(thread);
          const p: ParkedThread = {
            thread,
            login,
            kind: owner.kind,
            parked: { ...parked, ...(checkAt !== undefined ? { checkAt } : {}) },
          };
          if (owner.taskId !== undefined) p.taskId = owner.taskId;
          const slot = this.parkedList.find(([k]) => k === key);
          if (slot) slot[1] = p;
          else this.parkedList.push([key, p]);
        }
        return;
      }
      case "thread.started": {
        if (event.threadId === undefined) return;
        this.unpark(`${machineId}/${event.threadId}`);
        this.machine(login).started.set(event.threadId, atMs);
        return;
      }
      // A turn that failed or was stopped proves nothing; it only leaves `started`.
      case "thread.failed":
      case "thread.interrupted": {
        if (event.threadId !== undefined) this.machines.get(login)?.started.delete(event.threadId);
        return;
      }
      case "thread.completed": {
        const m = this.machine(login);
        const t = event.threadId;
        if (t === undefined) return;
        const p = m.breaker?.probe;
        if (p && p.threadId === t && atMs >= p.atMs) p.completed = true;
        // The login served a whole turn: limits with no reset start their backoff over.
        if (m.started.delete(t)) m.streaks.clear();
        return;
      }
      case "usage.breaker": {
        const m = this.machine(login);
        UsageState.remember(m, event);
        const cls = data.class;
        const breaker: Breaker = {
          class: cls === "usage_limit" || cls === "rate_limit" || cls === "pool_exhausted" ? cls : "usage_limit",
          since: event.at,
          message: event.summary,
          checks: 0,
          proxy: data.proxy === true,
        };
        if (str(data.until) !== undefined) breaker.until = str(data.until);
        if (str(data.checkAt) !== undefined) breaker.checkAt = str(data.checkAt);
        if (str(data.model) !== undefined) breaker.model = str(data.model);
        m.breaker = breaker;
        return;
      }
      case "usage.resumed": {
        const m = this.machine(login);
        UsageState.remember(m, event);
        const by = str(data.by);
        const at = parseMs(event.at);
        if (by !== undefined && at !== undefined) m.resumedBy.set(by, at);
        const listed = (Array.isArray(data.threads) ? data.threads : [])
          .map((t) => str((t as Record<string, unknown> | null)?.threadId))
          .filter((t): t is string => t !== undefined);
        if (data.breakerCleared === true) {
          delete m.breaker;
          m.recent = [];
        } else if (m.breaker && data.check === true) {
          const b = m.breaker;
          const first = listed[0];
          if (first !== undefined) b.probe = { threadId: first, atMs, completed: false, limited: false };
          else delete b.probe;
          b.checks += 1;
          b.checkAt = isoMs(atMs + checkAfterMs(b.checks));
        }
        for (const id of listed) this.unpark(`${machineId}/${id}`);
        return;
      }
      default:
        return;
    }
  }

  /**
   * What a thread.completed lifts, read before the event is applied: a turn that started on the login after a limit
   * that named no reset, on any model, closes such a breaker and resumes what is parked with no reset there, or, with
   * no breaker, those parks it proves over. A known reset waits for itself, and pool_exhausted for usage_resume.
   */
  liftedBy(event: HubEvent, account: string | undefined): Lifted | undefined {
    if (event.type !== "thread.completed" || event.machineId === undefined || event.threadId === undefined) return undefined;
    const machineId = loginKey(event.machineId, account);
    const m = this.machines.get(machineId);
    const started = m?.started.get(event.threadId);
    if (!m || started === undefined) return undefined;
    const proves = (since: string) => {
      const s = parseMs(since);
      return s !== undefined && started >= s;
    };
    const unknown = (cls: UsageClass, reset: string | undefined) => cls !== "pool_exhausted" && reset === undefined;
    const breakerCleared = m.breaker !== undefined && unknown(m.breaker.class, m.breaker.until) && proves(m.breaker.since);
    const unknownParks = this.parkedOn(machineId).filter((p) => unknown(p.parked.class, p.parked.resumeAt));
    const threads = !m.breaker
      ? unknownParks.filter((p) => proves(p.parked.since))
      : breakerCleared
        ? unknownParks
        : [];
    return breakerCleared || threads.length > 0 ? { machineId, threads, breakerCleared } : undefined;
  }

  /**
   * The usage.breaker event to emit when the login's recent hits call for it: two of one class within 10 minutes, or
   * one pool_exhausted. Returns the event and when to look again: the reset the limits named, else the first check.
   */
  trip(login: string, at: string): [NewEvent, string | undefined] | undefined {
    const m = this.machines.get(login);
    const last = m?.recent.at(-1);
    if (!m || !last || m.breaker) return undefined;
    const same = m.recent.filter((h) => h.class === last.class);
    if (last.class !== "pool_exhausted" && same.length < 2) return undefined;
    const resets = same
      .map((h) => h.resumeAt)
      .filter((r): r is string => r !== undefined)
      .sort(cmpStr);
    const pool = last.class === "pool_exhausted";
    const until = pool ? undefined : resets.at(-1);
    const atMs = parseMs(at);
    const checkAt = !pool && until === undefined && atMs !== undefined ? isoMs(atMs + checkAfterMs(0)) : undefined;
    const counts = this.countsOn(login);
    const data: Record<string, unknown> = { class: last.class, parked: counts };
    if (until !== undefined) data.until = until;
    if (checkAt !== undefined) data.checkAt = checkAt;
    if (last.model !== undefined) data.model = last.model;
    if (last.proxy) data.proxy = true;
    const event: NewEvent = {
      at,
      type: "usage.breaker",
      machineId: splitLogin(login)[0],
      summary: breakerMessage(login, last.class, until, last.model, last.proxy, counts),
      data: withAccount(data, login),
      attention: "loud",
    };
    return [event, until ?? checkAt];
  }

  /**
   * What is due at `nowMs`, per login; unparks nothing (the service does, as it sends). A breaker past its reset
   * clears and resumes everything. One with no reset is checked: when the thread the last check sent got through, it
   * clears the same way; otherwise one parked thread is tried, and nothing else moves.
   */
  due(nowMs: number): Due[] {
    const at = (t: string | undefined) => {
      const ms = t === undefined ? undefined : parseMs(t);
      return ms !== undefined && ms <= nowMs;
    };
    const out: Due[] = [];
    for (const machineId of this.logins()) {
      const m = this.machines.get(machineId) as MachineUsage;
      const b = m.breaker;
      if (b && at(b.until)) {
        out.push({ machineId, threads: this.parkedOn(machineId), breakerCleared: true, check: false });
      } else if (b && at(b.checkAt)) {
        const p = b.probe;
        const through = p !== undefined && gotThrough(p);
        const parked = this.parkedOn(machineId);
        const inFlight =
          p && !p.completed && !p.limited && nowMs < p.atMs + PROBE_WAIT_MS && !parked.some((t) => t.thread.threadId === p.threadId)
            ? isoMs(p.atMs + PROBE_WAIT_MS)
            : undefined;
        const due: Due = { machineId, threads: parked, breakerCleared: through, check: true };
        if (inFlight !== undefined && !through) due.inFlightUntil = inFlight;
        out.push(due);
      } else if (!b) {
        const threads = this.parkedOn(machineId).filter((p) => at(p.parked.resumeAt) || at(p.parked.checkAt));
        if (threads.length > 0) out.push({ machineId, threads, breakerCleared: false, check: false });
      }
    }
    return out;
  }

  /** `list` in resume order: leads, then reviews, then writers, oldest park first. */
  static inOrder(list: ParkedThread[]): ParkedThread[] {
    return [...list].sort((a, b) => RANK[a.kind] - RANK[b.kind] || cmpStr(a.parked.since, b.parked.since));
  }

  /** Takes `list` out of the parked set in resume order. */
  takeInOrder(list: ParkedThread[]): ParkedThread[] {
    const ordered = UsageState.inOrder(list);
    for (const p of ordered) this.unpark(keyOf(p.thread));
    return ordered;
  }

  /** Takes one thread out of the parked set, as a check sends it. */
  take(thread: ThreadKey): void {
    this.unpark(keyOf(thread));
  }

  /** Why a new turn may not start on the login now, as a queued reason. */
  gate(login: string, nowMs: number): string | undefined {
    const b = this.machines.get(login)?.breaker;
    if (!b) return undefined;
    const until = b.until === undefined ? undefined : parseMs(b.until);
    if (until !== undefined && until <= nowMs) return undefined;
    return [...gateText(login, b)].slice(0, 200).join("");
  }

  /** `gate` of the thread's login (its machine's own, or its `account`'s there), or why this thread is parked. */
  hold(thread: ThreadKey, account: string | undefined, nowMs: number): string | undefined {
    const paused = this.gate(loginKey(thread.machineId, account), nowMs);
    if (paused !== undefined) return paused;
    const p = this.parked(thread);
    if (!p) return undefined;
    if (p.resumeAt !== undefined) return `usage: parked until ${resetText(p.resumeAt)}`;
    if (p.checkAt !== undefined) {
      return p.proxy ? "usage: parked, rate-limited by your proxy, checking again shortly" : "usage: parked, checking again shortly";
    }
    return "usage: parked until usage_resume";
  }
}

/** A thread sent "continue", as usage.resumed lists it. */
export type Resumed = { threadId: string; kind: ParkedKind; taskId?: string };

/** Why a usage.resumed went out, as its `by` says: "reset", "check", "unchecked", "turn", or who ran usage_resume. */
function resumedWhy(by: string): string {
  switch (by) {
    case "reset":
      return "the limit reset";
    case "check":
      return "the turn a check tried completed";
    case "unchecked":
      return "nothing was left parked to check it with; the next turn there tries the login";
    case "turn":
      return "a turn on its login succeeded";
    default:
      return `usage_resume by ${by}`;
  }
}

/** The usage.resumed event for what went out; undefined when nothing changed. A `check` keeps the breaker open. */
export function resumedEvent(
  login: string,
  at: string,
  sent: Resumed[],
  breakerCleared: boolean,
  by: string,
): NewEvent | undefined {
  if (!breakerCleared && sent.length === 0) return undefined;
  const what = `sent "continue" to ${plural(sent.length, "parked thread")}`;
  const [where, loginName] = [place(login), loginText(login)];
  let summary: string;
  if (breakerCleared && sent.length === 0) summary = `Usage pause on ${where} lifted (${resumedWhy(by)})`;
  else if (breakerCleared) summary = `Usage pause on ${where} lifted (${resumedWhy(by)}); ${what}`;
  else if (by === "turn") summary = `A turn succeeded on ${loginName}; ${what}`;
  else if (by === "check") summary = `Trying ${loginName} again; ${what}`;
  else summary = `Usage limit reset on ${where}; ${what}`;
  const threads = sent.slice(0, RESUMED_LISTED).map((r) => ({
    threadId: r.threadId,
    kind: r.kind,
    ...(r.taskId !== undefined ? { taskId: r.taskId } : {}),
  }));
  const data: Record<string, unknown> = { breakerCleared, by, threads };
  if (by === "check" && !breakerCleared) data.check = true;
  return { at, type: "usage.resumed", machineId: splitLogin(login)[0], summary, data: withAccount(data, login) };
}

/** The soft brake: new agents wait while a usage window of the machine's login is this used. */
export const BRAKE_PAUSE = 0.9;
/** A braked machine starts new agents again once every window is below this, or past its reset. */
export const BRAKE_LIFT = 0.85;
/** A reading with no usable reset time no longer counts once it is older than this (on the node's clock). */
export const BRAKE_STALE_MS = 15 * 60_000;

/** The window that holds new agents back. */
export type Brake = { limitType: string; utilization?: number; observedMs?: number; resetsMs?: number };

/** "5-hour", "7-day Opus"; other windows by claude's own name. */
function windowText(limitType: string): string {
  switch (limitType) {
    case "five_hour":
      return "5-hour";
    case "seven_day":
      return "7-day";
    case "seven_day_opus":
      return "7-day Opus";
    case "seven_day_sonnet":
      return "7-day Sonnet";
    default:
      return limitType.replaceAll("_", " ");
  }
}

/** "Paused new agents: 5-hour limit 91% on builder-1 as of Tue 13:42 UTC, resets Tue 14:00 UTC (pauses at 90%, lifts below 85%)". */
export function brakeText(b: Brake, machine: string): string {
  const used = b.utilization === undefined ? "warning" : `${(b.utilization * 100).toFixed(0)}%`;
  const observed = b.observedMs === undefined ? "" : ` as of ${dayTime(b.observedMs)} UTC`;
  const resets = b.resetsMs === undefined ? "" : `, resets ${dayTime(b.resetsMs)} UTC`;
  return `Paused new agents: ${windowText(b.limitType)} limit ${used} on ${machine}${observed}${resets} (pauses at ${(BRAKE_PAUSE * 100).toFixed(0)}%, lifts below ${(BRAKE_LIFT * 100).toFixed(0)}%)`;
}

/**
 * The soft brake over the windows the machine's login last reported: the most used window at BRAKE_PAUSE or more
 * (BRAKE_LIFT once `braked`), or undefined. A window past its reset (by the hub's clock) no longer counts; one with
 * no reset counts only while read at most BRAKE_STALE_MS before `nodeNowMs`. A warning with no figure counts as full.
 */
export function brake(limits: LoginLimit[], braked: boolean, nowMs: number, nodeNowMs: number): Brake | undefined {
  const at = braked ? BRAKE_LIFT : BRAKE_PAUSE;
  let best: [number, Brake] | undefined;
  for (const l of limits) {
    const resets = l.resetsAt === undefined ? undefined : parseMs(l.resetsAt);
    if (resets !== undefined && resets <= nowMs) continue;
    const observed = l.observedAt === undefined ? undefined : parseMs(l.observedAt);
    if (resets === undefined && (observed === undefined || nodeNowMs - observed > BRAKE_STALE_MS)) continue;
    let used: number;
    if (l.utilization !== undefined && l.utilization !== null) used = l.utilization;
    else if (l.status !== "allowed") used = Infinity;
    else continue;
    if (used < at) continue;
    const b: Brake = { limitType: l.limitType };
    if (l.utilization !== undefined && l.utilization !== null) b.utilization = l.utilization;
    if (observed !== undefined) b.observedMs = observed;
    if (resets !== undefined) b.resetsMs = resets;
    // Rust's max_by keeps the last of equals.
    if (!best || used >= best[0]) best = [used, b];
  }
  return best?.[1];
}
