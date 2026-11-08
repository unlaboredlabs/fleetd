// Wakes to a lead (crates/fleetd/src/hub/leads/wakes.rs): triggers for one lead are debounced and coalesced into a
// single message, the code-rendered digest then one event line per trigger (`events`).
import type { ProjectRef, Workstream } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { digestLines as checklistLines } from "../checklist/index.ts";
import { prompts, type PromptSet } from "../prompts/store.ts";
import * as repos from "../repos/store.ts";
import { digestLine as steerLine } from "../steer/index.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs, nowMs } from "../store/time.ts";
import { idleLine, renderLeadDigest, type WorkstreamFacts } from "./digest.ts";
import { renderEvent } from "./events.ts";
import { leadState } from "./lead_state.ts";
import { decisionsInProject, leadWiring, openRequests } from "./ports.ts";
import { LeadRecords } from "./records.ts";
import { quiet as isQuiet, type Trigger } from "../api/leads.ts";

/** The trigger's kind as `lead.woken` lists it. */
const triggerKind = (t: Trigger) => (t.kind === "intent" ? "intent" : t.line);

export const WAKE_DEBOUNCE_MS = 10_000;
/** A steady trigger stream still wakes the lead this long after the first pending trigger. */
export const WAKE_MAX_WAIT_MS = 60_000;
/** How long a wake to an idle lead still waits for what comes right behind it. */
export const WAKE_COALESCE_MS = 5_000;
/** The longest order said in one line, as the order event quotes it. */
const ORDER_LINE = 300;

/** One event line per trigger, in the order they came. */
export function triggerLines(triggers: Trigger[]): string[] {
  return triggers.map((t) => {
    if (t.kind === "line") return t.text;
    if (t.text.includes("\n") || [...t.text].length > ORDER_LINE) {
      // An order that says more than a line goes in whole: the one line would cut it.
      const body = t.text
        .trim()
        .split("\n")
        .map((l) => `  ${l}`.trimEnd());
      return `- new order ${t.workstreamId}, in full:\n${body.join("\n")}`;
    }
    return renderEvent({ kind: "order", workstream: t.workstreamId, text: t.text });
  });
}

export const renderWake = (set: PromptSet, digest: string, triggers: Trigger[]) => set.render("lead.wake", { state: digest, events: triggerLines(triggers).join("\n") });

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

type Pending<T> = { entry: number; items: T[]; generation: number; firstMs: number; nowAtMs?: number };

/**
 * Coalesces items per key: a key flushes once no new item arrived for `debounce`, or `maxWait` after its first pending
 * item, or `coalesce` after an item pushed with `now` unless the key flushed within `debounce`. Timers are never
 * cancelled: a superseded one wakes, sees a newer generation and does nothing.
 */
export class Debouncer<T> {
  private readonly pending = new Map<string, Pending<T>>();
  private readonly flushed = new Map<string, number>();
  private nextEntry = 0;

  constructor(
    private readonly now: () => number,
    private readonly debounceMs: number,
    private readonly maxWaitMs: number,
    private readonly coalesceMs: number,
    private readonly sleep: Sleep = realSleep,
  ) {}

  push(key: string, item: T, now: boolean, flush: (key: string, items: T[]) => Promise<void> | void): void {
    const at = this.now();
    const last = this.flushed.get(key);
    const quiet = last === undefined || at - last >= this.debounceMs;
    let p = this.pending.get(key);
    if (!p) {
      p = { entry: this.nextEntry++, items: [], generation: 0, firstMs: at };
      this.pending.set(key, p);
    }
    p.items.push(item);
    p.generation += 1;
    if (now && quiet && p.nowAtMs === undefined) p.nowAtMs = at + this.coalesceMs;
    // The quiet window, cut short so the latest timer never sleeps past the max-wait deadline.
    const due = p.nowAtMs ?? at + this.debounceMs;
    const delay = Math.max(Math.min(due, p.firstMs + this.maxWaitMs) - at, 0);
    const { entry, generation } = p;
    void this.sleep(delay).then(async () => {
      const cur = this.pending.get(key);
      if (!cur || cur.entry !== entry || cur.generation !== generation) return;
      this.flushed.set(key, this.now());
      this.pending.delete(key);
      await flush(key, cur.items);
    });
  }

  /** Adds `item` to the flush already pending for `key`, without moving its time; hands it back when none is. */
  join(key: string, item: T): T | undefined {
    const p = this.pending.get(key);
    if (!p) return item;
    p.items.push(item);
    return undefined;
  }

  hasPending(key: string): boolean {
    return this.pending.has(key);
  }
}

const keyOf = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;
const refOf = (key: string): ProjectRef => {
  const at = key.indexOf("/");
  return { machineId: key.slice(0, at), projectId: key.slice(at + 1) };
};

/** A wake's request id, which names its run on the node: `at` is the wake's `lastWakeAt`. */
export const wakeRequestId = (r: ProjectRef, sessionGeneration: number, at: string) => `fleetd-wake:${keyOf(r)}:${sessionGeneration}:${at}`;

/** The orders a wake serves: an intent's, and any `W<n>` a line names or whose task `T<n>` it names. */
function triggerWorkstreams(triggers: Trigger[], taskOrder: (t: string) => string | undefined): string[] {
  const out: string[] = [];
  for (const t of triggers) {
    const found =
      t.kind === "intent"
        ? [t.workstreamId]
        : [...t.text.matchAll(/\b[WT][1-9][0-9]*\b/g)].flatMap((m) => (m[0].startsWith("T") ? (taskOrder(m[0]) ?? []) : [m[0]]));
    for (const w of found) if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** Why an archived project's lead takes no turn (lead.rs `refuse_archived`); undefined for any other project. */
export function archivedNote(hub: Hub, r: ProjectRef): { message: string; fix: string } | undefined {
  const holder = repos.holders(hub.db.conn, r)[0];
  if (!holder) return undefined;
  return {
    message: `This project is archived: its directory is repo ${holder.repo.name} of project ${holder.project.projectId} on ${holder.project.machineId}.`,
    fix: "Write to that project's lead instead; project_repo_remove takes the repo out of it and brings this project back.",
  };
}

export class LeadWakes {
  private readonly records: LeadRecords;
  readonly debouncer: Debouncer<Trigger>;
  /** One flush at a time. */
  private flushing: Promise<void> = Promise.resolve();
  /** When the pending wake's first trigger came, per project: `lead.woken.firstTriggerAt`. */
  private readonly first = new Map<string, string>();
  /** Quiet lines that came while no wake was on its way, per project: they go first in the next one. */
  private readonly quietHeld = new Map<string, Trigger[]>();
  /** The idle stretch whose idle line the project's lead was shown: one line per stretch. */
  private readonly idleShown = new Map<string, number>();
  /** A wake to a cold lead, or one whose MCP servers changed, starts a fresh session (set by the leads area). */
  freshIfDue: (r: ProjectRef, first: string) => Promise<boolean> = async () => false;

  constructor(
    private readonly hub: Hub,
    sleep?: Sleep,
  ) {
    this.records = new LeadRecords(hub.db);
    this.debouncer = new Debouncer(() => hub.clock.now(), WAKE_DEBOUNCE_MS, WAKE_MAX_WAIT_MS, WAKE_COALESCE_MS, sleep);
  }

  private nowIso(): string {
    return isoMs(nowMs(this.hub.clock));
  }

  /**
   * Queues a trigger; the lead is woken once no new trigger has arrived for WAKE_DEBOUNCE, or WAKE_MAX_WAIT after the
   * first. To an idle lead not woken within WAKE_DEBOUNCE, a trigger goes WAKE_COALESCE after it.
   */
  trigger(r: ProjectRef, trigger: Trigger): void {
    const key = keyOf(r);
    if (isQuiet(trigger)) {
      const held = this.debouncer.join(key, trigger);
      if (held) this.quietHeld.set(key, [...(this.quietHeld.get(key) ?? []), held]);
      return;
    }
    if (!this.first.has(key)) this.first.set(key, this.nowIso());
    this.debouncer.push(key, trigger, this.leadIdle(r), (k, items) => this.flush(refOf(k), items));
  }

  /** The lead's thread is idle as the store last saw it: not mid-turn, not waiting on a person, not starting. */
  private leadIdle(r: ProjectRef): boolean {
    const lead = this.records.leadGet(r);
    if (!lead) return false;
    const thread = store(this.hub).threadGet({ machineId: r.machineId, threadId: lead.threadId })?.thread;
    return leadState(thread, false) === "idle";
  }

  /** Whether a wake for the project's lead is already on its way. */
  pending(r: ProjectRef): boolean {
    return this.debouncer.hasPending(keyOf(r));
  }

  /** The quiet lines held for the project's next wake. */
  held(r: ProjectRef): string[] {
    return triggerLines(this.quietHeld.get(keyOf(r)) ?? []);
  }

  /** The lead digest as of now: the state block at the top of its first message and of every wake. */
  digest(r: ProjectRef): string {
    return this.digestToSend(r).text;
  }

  /** The idle line of stretch `since` reached the lead: later digests leave it out until the next stretch. */
  idleSent(r: ProjectRef, since: number | undefined): void {
    if (since !== undefined) this.idleShown.set(keyOf(r), since);
  }

  /** The digest, and the idle stretch whose line it carries. */
  digestToSend(r: ProjectRef): { text: string; idleSince?: number } {
    const hooks = leadWiring(this.hub).hooks;
    const project = store(this.hub).projectGet(r);
    const workstreams = this.records.workstreamsList({ projectRef: r, state: "open", limit: 50 });
    const since = this.records.leadGet(r)?.lastWakeAt;
    const requests = openRequests(this.hub, r, 50);
    const decisions = decisionsInProject(this.hub, r, 500);
    const tasks = hooks.tasks?.digestLines(r, since, 50);
    const agents = hooks.tasks?.agents(r);
    const usage = hooks.usageGate?.(r);
    let idle: string | undefined;
    let idleSince: number | undefined;
    if (agents) {
      const line = idleLine(agents, workstreams, requests, usage !== undefined);
      if (line !== undefined && this.idleShown.get(keyOf(r)) !== agents.idleSinceMs) {
        idle = line;
        idleSince = agents.idleSinceMs;
      }
    }
    const text = renderLeadDigest({
      projectRef: r,
      title: project?.title ?? r.projectId,
      at: this.nowIso(),
      workstreams,
      openRequests: requests,
      decisions,
      ...(agents ? { agents } : {}),
      ...(idle === undefined ? {} : { idle }),
      ...(usage === undefined ? {} : { usage }),
      ...(tasks ? { tasks } : {}),
      ...(() => {
        const train = hooks.trainLines?.(r, since);
        return train ? { train } : {};
      })(),
      ...(() => {
        const elsewhere = hooks.elsewhere?.(r);
        return elsewhere ? { elsewhere } : {};
      })(),
      ...(() => {
        const checklist = checklistLines(this.hub.db, r);
        return checklist ? { checklist } : {};
      })(),
      facts: this.workstreamFacts(workstreams),
    });
    return { text, ...(idleSince === undefined ? {} : { idleSince }) };
  }

  /** Per workstream with a brief: its steers. */
  workstreamFacts(workstreams: Workstream[]): Map<string, WorkstreamFacts> {
    const facts = new Map<string, WorkstreamFacts>();
    for (const w of workstreams.filter((x) => x.brief !== undefined)) {
      const steers = steerLine(this.hub, w.workstreamId);
      facts.set(w.workstreamId, steers === undefined ? {} : { steers });
    }
    return facts;
  }

  private flush(r: ProjectRef, triggers: Trigger[]): Promise<void> {
    const run = this.flushing.then(async () => {
      // Held quiet lines came before every trigger here.
      const key = keyOf(r);
      const held = this.quietHeld.get(key) ?? [];
      this.quietHeld.delete(key);
      try {
        await this.flushInner(r, [...held, ...triggers]);
      } catch (error) {
        console.warn(`lead wake of ${key} failed:`, error);
      }
    });
    this.flushing = run;
    return run;
  }

  private async flushInner(r: ProjectRef, all: Trigger[]): Promise<void> {
    // A flush due after the hub stopped has no store to read.
    if (this.hub.shutdown.signal.aborted) return;
    const key = keyOf(r);
    if (archivedNote(this.hub, r)) return void console.info(`lead wake of ${key} dropped: archived`);
    const lead = this.records.leadGet(r);
    // No lead yet: its first message carries the digest, which shows the same state.
    if (!lead) return void console.info(`lead wake of ${key} dropped: project has no lead`);
    // An archived Navi's lead takes no turns.
    if (store(this.hub).projectGet(r)?.archivedAt !== undefined) return;
    // The lead's first message listed every intent made before it started; a wake would say it twice.
    const triggers = all.filter((t) => {
      if (t.kind !== "intent") return true;
      const w = this.records.workstreamGet(t.workstreamId);
      return !w || w.createdAt >= lead.startedAt;
    });
    if (triggers.length === 0) return;
    const thread = { machineId: r.machineId, threadId: lead.threadId };
    const wiring = leadWiring(this.hub);
    // A wake is a turn, so it waits while the login is paused or the lead is parked, then goes again.
    if (wiring.hooks.usageHold?.(thread) !== undefined) {
      const clear = wiring.hooks.whenClear?.(thread) ?? Promise.resolve();
      void clear.then(() => {
        for (const t of triggers) this.trigger(r, t);
      });
      return;
    }
    const set = prompts(this.hub.db).forThread(r.machineId, lead.threadId);
    // A lead due a fresh session gets its events in the first message of a fresh session.
    let fresh = false;
    try {
      fresh = await this.freshIfDue(r, renderWake(prompts(this.hub.db).current(r), "", triggers));
    } catch (error) {
      console.warn(`fresh lead of ${key} not started; resuming it:`, error);
    }
    const at = this.nowIso();
    let current = lead;
    let queued = false;
    if (fresh) current = this.records.leadGet(r) ?? lead;
    else {
      const { text: digest, idleSince } = this.digestToSend(r);
      const message = renderWake(set, digest, triggers);
      try {
        // Through the offline write queue, so a wake to an offline machine waits for it instead of being dropped.
        queued = await wiring.ports.send(thread, message, wakeRequestId(r, lead.sessionGeneration, at));
        this.idleSent(r, idleSince);
      } catch (error) {
        return void console.warn(`lead wake of ${key} not delivered: ${(error as Error).message}`);
      }
    }
    this.records.leadPut({ ...current, lastWakeAt: at });
    const first = this.first.get(key) ?? at;
    this.first.delete(key);
    const n = triggers.length;
    const data: Record<string, unknown> = {
      triggers: triggers.map(triggerKind),
      firstTriggerAt: first,
      workstreamIds: triggerWorkstreams(triggers, (t) =>
        this.hub.db.all<{ workstream_id: string }>("SELECT workstream_id FROM tasks WHERE n = ?1", [Number(t.slice(1))])[0]?.workstream_id,
      ),
    };
    if (queued) data.queued = true;
    events(this.hub).append({
      at,
      type: "lead.woken",
      machineId: r.machineId,
      projectId: r.projectId,
      threadId: current.threadId,
      summary: `Lead of ${r.projectId} ${queued ? "wake queued" : "woken"} with ${n} trigger${n === 1 ? "" : "s"}`,
      data,
    });
  }
}
