// What the train and the review gate take from other hub areas: tasks,
// workstreams, the event log and wakes. One port, so the logic tests run on a fake and the hub provides it from its
// services (`HubHost`, hub_host.ts).
import type { Brief, Merger, MergeMode, ProjectRef, RiskRules } from "../../shared/contracts.ts";

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

/** A write task under way (queued, running or idle) as the watch reads it: what it was asked, its title and prompt. */
export type WorkView = { taskId: string; workstreamId: string; text: string };

export type WorkstreamView = {
  workstreamId: string;
  projectRef: ProjectRef;
  hasBrief: boolean;
  /** Neither done nor stopped: tasks, reviewers included, run only for an open workstream. */
  open: boolean;
  /** Opened by the train for a PR's `fleetd-train` label (label.ts): it closes when the PR merges or closes. */
  fromLabel?: boolean;
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
  /** What an ended task still waits on that may wake it by itself (its wait_ci, a Monitor), besides its waits on the
   * PR `except`; undefined for none. */
  waitingOn?(taskId: string, except?: string): string | undefined;
  /** Keeps `text` for the task's next run, whatever starts it, without starting it (Tasks.holdMessage). */
  holdMessage?(projectRef: ProjectRef, by: string, taskId: string, text: string): Promise<void>;
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
  /** Runs `argv` in `cwd` on the machine of `checkout`, at most `timeoutSec`; throws why it can't run there now. */
  nodeRun(checkout: ProjectRef, cwd: string, argv: string[], timeoutSec: number): Promise<NodeRun>;
  /**
   * Who merges the project's PRs (its Who merges) and its risk rules: where people merge, the train reviews them and
   * keeps them up to date, and merges only one its rules let merge itself (merge_rules.ts `decide`). Throws when it
   * can't be read. Absent: fleetd merges.
   */
  whoMerges?(projectRef: ProjectRef): { merges: Merger; rules: RiskRules };
  /** How the train merges the project's PRs (verify.ts, lanes.ts): absent, test, then merge. */
  mergeMode?(projectRef: ProjectRef): MergeMode;
  /** LeadWakes.trigger(ref, { kind: "train", line }). */
  wakeLead(projectRef: ProjectRef, line: string): Promise<void>;
  /** One author=system line in the project's chat (Chat.systemLine); never throws. Absent: the chat gets none. */
  tellPerson?(projectRef: ProjectRef, text: string): void;
  /** The project's branch prefix (its policy's `branchPrefix`, default `fleetd/`); undefined when unreadable now. */
  branchPrefix(projectRef: ProjectRef): Promise<string | undefined>;
  /** The `Fixes` line a PR of `workstreamId` in `repo` lands with, when the order is a GitHub issue's (hub/issues). */
  issueFixes?(workstreamId: string, repo: string): string | undefined;
  /** Opens an order for the project's lead (channel `train`) with `text`; the same `requestId` finds the first. */
  openOrder(projectRef: ProjectRef, text: string, requestId: string): Promise<string>;
  /**
   * Opens an order with its brief set at once, for a PR labelled `fleetd-train` (label.ts): the same `requestId` finds
   * the first while it is open, and `stopped` answers one a person stopped, opening none. Absent: the train takes no
   * PR by its label.
   */
  openBriefedOrder?(projectRef: ProjectRef, text: string, requestId: string, brief: Brief): Promise<{ workstreamId: string; stopped?: true }>;
  /** Closes an order as its lead's `close` does; throws its refusal. */
  closeOrder?(projectRef: ProjectRef, workstreamId: string, reason: string): Promise<void>;
  /** Whether the work ledger's landing scanner watches `repo`'s `base`. */
  landingsWatched(repo: string, base: string): boolean;
  /** Where the train's state and CI spans go; none in tests. */
  time(): TimeSink | undefined;
  /** The write tasks under way in the project's open orders. Absent: none. */
  tasksUnderWay?(projectRef: ProjectRef): WorkView[];
}

/** The defaults the Rust trait gives, for hosts that leave them out. */
export const HOST_DEFAULTS = {
  githubRepos: (): [string, ProjectRef][] => [],
  repoProjects: (): ProjectRef[] => [],
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
