// What the train and the review gate take from other hub areas: tasks,
// workstreams, the event log and wakes. One port, so the logic tests run on a fake and the hub provides it from its
// services (`HubHost`, hub_host.ts).
import type { ProjectRef } from "../../shared/contracts.ts";

/** The parts of a Task the train and reviews read. */
export type TaskView = {
  taskId: string;
  projectRef: ProjectRef;
  workstreamId: string;
  /** "write", "review", ... */
  kind: string;
  /** "done", "failed", "running", ... */
  state: string;
  /** `result.prUrl`. */
  prUrl?: string;
  /** `result.tail`. */
  resultTail?: string;
};

export type WorkstreamView = {
  workstreamId: string;
  projectRef: ProjectRef;
  hasBrief: boolean;
  /** Neither done nor stopped: tasks, reviewers included, run only for an open workstream. */
  open: boolean;
};

export type EventView = { seq: number; eventType: string; data: unknown };

/** A review task as Tasks.spawn takes it (kind "review"), from the caller `by` in `projectRef`. */
export type ReviewSpawn = { projectRef: ProjectRef; by: string; workstreamId: string; title: string; prompt: string; pr: string };

/** How a command the train ran on a node ended: its exit code (undefined when it timed out or could not run). */
export type NodeRun = { exitCode?: number; outputTail: string };

/** Where the train's state and CI spans go (src/hub/time). */
export interface TimeSink {
  close(prefix: string, atMs: number): void;
  span(span: Record<string, unknown>): void;
}

export interface TrainHost {
  task(taskId: string): TaskView | undefined;
  /** The project's write tasks that are running or done, with their branches. */
  writers(projectRef: ProjectRef): [string, string][];
  /** Tasks.message from `by`; throws its message. */
  messageTask(projectRef: ProjectRef, by: string, taskId: string, text: string): Promise<void>;
  /** Tasks.cancel from `by`, with `reason` as its result; throws its message. */
  cancelTask(projectRef: ProjectRef, by: string, taskId: string, reason: string): Promise<void>;
  /** Tasks.spawn of a review task; throws its message. */
  spawnReview(spawn: ReviewSpawn): Promise<TaskView>;
  workstream(workstreamId: string): WorkstreamView | undefined;
  /** EventLog.append at now, on the project. */
  appendEvent(projectRef: ProjectRef, eventType: string, summary: string, data: unknown): void;
  eventsHead(): number;
  /** EventLog.wait: the events after `cursor` of these types, and the new cursor. */
  eventsWait(cursor: number, types: string[], timeoutSec: number, signal?: AbortSignal): Promise<{ events: EventView[]; cursor: number }>;
  /** The project's checkout (`workspaceRoot`) on its machine; undefined once the project is removed. */
  projectRoot(projectRef: ProjectRef): string | undefined;
  /**
   * Whether the project is known to be removed: never when its lookup fails, so a store error can't take a live
   * project's work off the train (it is looked at again on the next pass). Absent: it has no checkout left.
   */
  projectRemoved?(projectRef: ProjectRef): boolean;
  /** The project's repos on GitHub, each `owner/name` lowercased, with the node checkout holding its files. */
  githubRepos(projectRef: ProjectRef): [string, ProjectRef][];
  /** The projects still on their machines that have `repo` as one of their repos. */
  repoProjects(repo: string): ProjectRef[];
  /** Whether the person behind `by` sees `other` (D338). */
  sees(by: ProjectRef, other: ProjectRef): boolean;
  /** Runs `argv` in `cwd` on the machine of `checkout`, at most `timeoutSec`; throws why it can't run there now. */
  nodeRun(checkout: ProjectRef, cwd: string, argv: string[], timeoutSec: number): Promise<NodeRun>;
  /** LeadWakes.trigger(ref, { kind: "train", line }). */
  wakeLead(projectRef: ProjectRef, line: string): Promise<void>;
  /** The project's branch prefix (its policy's `branchPrefix`, default `fleetd/`); undefined when unreadable now. */
  branchPrefix(projectRef: ProjectRef): Promise<string | undefined>;
  /** Opens an order for the project's lead (channel `train`) with `text`; the same `requestId` finds the first. */
  openOrder(projectRef: ProjectRef, text: string, requestId: string): Promise<string>;
  /** Whether the work ledger's landing scanner watches `repo`'s `base`. */
  landingsWatched(repo: string, base: string): boolean;
  /** Where the train's state and CI spans go; none in tests. */
  time(): TimeSink | undefined;
}

/** The defaults the Rust trait gives, for hosts that leave them out. */
export const HOST_DEFAULTS = {
  githubRepos: (): [string, ProjectRef][] => [],
  repoProjects: (): ProjectRef[] => [],
  sees: () => true,
  nodeRun: async (): Promise<NodeRun> => {
    throw new Error("this hub runs nothing on its nodes for the train");
  },
  branchPrefix: async (): Promise<string | undefined> => "fleetd/",
  openOrder: async (): Promise<string> => {
    throw new Error("this hub opens no orders");
  },
  landingsWatched: () => false,
  time: (): TimeSink | undefined => undefined,
};
