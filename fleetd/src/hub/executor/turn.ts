// One tool-less model turn the hub runs for itself and reads the answer of: a
// memory import's distilling (W229), an approval checker's verdict (W239). The session is launched on a project's
// machine, recorded as the hub's own (so the sweep never reports it as a session nobody owns), waited on to its end,
// and stopped either way: a session left running holds what it read in a process.
import type { HubEventType, PersonId, ProjectRef, ThreadRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { events } from "../store/events.ts";
import { executors } from "./index.ts";
import { type LaunchInput, type LaunchOptions, launch } from "./sessions.ts";
import { stop } from "./stop.ts";

const END_EVENTS: HubEventType[] = ["thread.completed", "thread.failed", "thread.interrupted", "thread.usage_limited"];

/** What the hub runs a turn for: where it records the session, and how long it waits. */
export const Owner = {
  /** Import memory (`hub/memory/import`). */
  MemoryImport: "memory_import",
  /** A Navi's approval checker (`hub/navi/checker`). */
  ApprovalCheck: "approval_check",
} as const;
export type Owner = (typeof Owner)[keyof typeof Owner];

/** A turn still going after this long is stopped, and fails. */
export const limitMs = (owner: Owner) => (owner === Owner.MemoryImport ? 240_000 : 120_000);

const table = (owner: Owner) => (owner === Owner.MemoryImport ? "memory_imports" : "approval_checks");
const ownerName = (owner: Owner) => (owner === Owner.MemoryImport ? "memory import" : "approval check");

/**
 * Runs one session to its end on a project's machine and gives back its last reply, or throws an Error saying why
 * there is none: the hub's executors, or a test's fake model.
 */
export type Turn = {
  run(r: ProjectRef, person: PersonId | undefined, input: LaunchInput, options: LaunchOptions): Promise<string>;
};

/** The hub's executors' turn for `owner`; `limit` is `limitMs(owner)` but in tests. */
export class ExecutorTurn implements Turn {
  constructor(
    readonly hub: Hub,
    readonly owner: Owner,
    readonly limit = limitMs(owner),
  ) {}

  async run(r: ProjectRef, person: PersonId | undefined, input: LaunchInput, options: LaunchOptions): Promise<string> {
    const { hub, owner } = this;
    const started = hub.clock.now();
    // Subscribed before the launch, so an end logged before the first look still wakes the wait.
    let changed = false;
    let wake: (() => void) | undefined;
    const unsubscribe = events(hub).subscribe(() => {
      changed = true;
      wake?.();
    });
    let thread: ThreadRef;
    try {
      const { threadId } = await launch(hub, r.machineId, input, options);
      thread = { machineId: r.machineId, threadId };
      owned(hub, owner, r, thread, person, started);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const shutdown = hub.shutdown.signal;
    const onShutdown = () => wake?.();
    shutdown.addEventListener("abort", onShutdown);
    let over = false;
    const waited = async (): Promise<boolean> => {
      for (;;) {
        const completed = ended(hub, thread, started);
        if (completed !== undefined) return completed;
        // The hub is going away, or the time ran out: no end will be read.
        if (shutdown.aborted || over) return false;
        if (!changed) await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
        changed = false;
      }
    };
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.limit);
    });
    let reply: { ok: string } | { err: string };
    try {
      const result = await Promise.race([waited(), timeout]);
      if (result === "timeout") reply = { err: "it ran past its time" };
      else if (!result) reply = { err: "it stopped before it answered" };
      else {
        const messages = await executors(hub).views.messages(thread);
        const last = messages.findLast((m) => m.role === "assistant" && m.text.trim() !== "");
        reply = last ? { ok: last.text } : { err: "it answered nothing" };
      }
    } catch (error) {
      reply = { err: (error as Error).message };
    } finally {
      clearTimeout(timer);
      unsubscribe();
      shutdown.removeEventListener("abort", onShutdown);
      // A wait the timeout won leaves its loop asleep: woken, it ends.
      over = true;
      wake?.();
    }
    // Its work is done either way; a session left running holds what it read in a process.
    try {
      await stop(hub, thread, false);
    } catch (error) {
      console.warn(`${ownerName(owner)}: session ${thread.threadId} not stopped: ${(error as Error).message}`);
    }
    if ("err" in reply) throw new Error(reply.err);
    return reply.ok;
  }
}

/** The hub's executors, which run `owner`'s turn on the project's machine (turn.rs `executors(hub, owner)`). */
export const turn = (hub: Hub, owner: Owner): Turn => new ExecutorTurn(hub, owner);

function owned(hub: Hub, owner: Owner, r: ProjectRef, thread: ThreadRef, person: PersonId | undefined, started: number): void {
  hub.db.conn
    .query(
      `INSERT OR IGNORE INTO ${table(owner)} (machine_id, thread_id, project_id, person_id, started_ms) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(thread.machineId, thread.threadId, r.projectId, person ?? null, started);
}

/** Whether the session ended after `startedMs`: true when it completed, undefined while it runs. */
function ended(hub: Hub, thread: ThreadRef, startedMs: number): boolean | undefined {
  const row = hub.db.conn
    .query<{ type: string }, [string, string, string, number]>(
      `SELECT type FROM events WHERE type IN (SELECT value FROM json_each(?1)) AND machine_id = ?2
         AND json_extract(data, '$.threadId') = ?3 AND created_ms >= ?4 ORDER BY seq LIMIT 1`,
    )
    .get(JSON.stringify(END_EVENTS), thread.machineId, thread.threadId, startedMs);
  return row ? row.type === "thread.completed" : undefined;
}
