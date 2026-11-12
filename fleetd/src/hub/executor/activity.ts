// What each followed thread is doing now, for the app's live lanes: one ActivityTracker (./activity_tracker.ts) per
// followed thread. Fed every thread event of a followed session: `activity(hub).onThreadEvent(machineId, frame)` from
// the executor; read by /app's live pump through `activity(hub).live(ref)`.
import type { ThreadRef } from "../../shared/contracts.ts";
import type { ThreadEventFrame } from "../../shared/sessions.ts";
import type { Hub } from "../api/hub.ts";
import { store } from "../store/hub_store.ts";
import { ActivityTracker, liveParts, type LiveParts, TRACKER_IDLE_MS } from "./activity_tracker.ts";

export {
  ActivityTracker,
  activityOf,
  commandLine,
  type DoneText,
  jsTake,
  type LiveParts,
  liveParts,
  StreamText,
  TEXT_TAIL_CHARS,
  TRACKER_IDLE_MS,
  WRITING_FOR_MS,
} from "./activity_tracker.ts";

/** How often the idle trackers are looked for. */
const PRUNE_EVERY_MS = 60_000;

/** Every followed thread's tracker, by machine and thread. */
export class Activities {
  private readonly trackers = new Map<string, { tracker: ActivityTracker; ready: boolean; lastMs: number }>();
  private lastPruneMs = 0;

  constructor(private readonly hub: Hub) {}

  /** One thread event of a followed session, as the executor got it. */
  onThreadEvent(machineId: string, frame: ThreadEventFrame): void {
    const now = this.hub.clock.now();
    this.prune(now);
    const key = `${machineId}\u0000${frame.sessionId}`;
    let entry = this.trackers.get(key);
    if (!entry) this.trackers.set(key, (entry = { tracker: new ActivityTracker(), ready: false, lastMs: now }));
    entry.lastMs = now;
    if (frame.event.type === "snapshot") {
      entry.tracker.setRoot(this.root(machineId, frame.event.summary));
      entry.ready = true;
    }
    entry.tracker.apply(frame.event, now);
  }

  /** Drops the trackers idle past TRACKER_IDLE_MS with no run going, at most once a minute. */
  private prune(now: number): void {
    if (now - this.lastPruneMs < PRUNE_EVERY_MS) return;
    this.lastPruneMs = now;
    for (const [key, entry] of this.trackers) {
      if (now - entry.lastMs > TRACKER_IDLE_MS && !entry.tracker.runActive()) this.trackers.delete(key);
    }
  }

  /** How many threads have a tracker. */
  size(): number {
    return this.trackers.size;
  }

  /** The executor stopped following the thread: its lane has no live parts. */
  forget(r: ThreadRef): void {
    this.trackers.delete(`${r.machineId}\u0000${r.threadId}`);
  }

  /** The live parts of a followed thread at the hub's now; undefined until its follow's snapshot came. */
  live(r: ThreadRef): LiveParts | undefined {
    const entry = this.trackers.get(`${r.machineId}\u0000${r.threadId}`);
    if (!entry?.ready) return undefined;
    return liveParts(entry.tracker, this.hub.clock.now());
  }

  /** Where a session's paths are relative to: its worktree, else its project's workspace root. */
  private root(machineId: string, summary: { worktreePath?: string; projectId: string }): string | undefined {
    if (summary.worktreePath) return summary.worktreePath;
    try {
      return store(this.hub).projectGet({ machineId, projectId: summary.projectId })?.workspaceRoot;
    } catch {
      return undefined;
    }
  }
}

/** `hub.area("activity")`. */
export const activity = (hub: Hub) => hub.area("activity", (h) => new Activities(h));
