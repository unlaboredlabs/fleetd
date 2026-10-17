// What tasks need from the executor beyond launch/send/interrupt: the branch a project's worktrees start from, and
// what a finished task thread changed. Provided by Executors.layer next to Executors and ThreadWatch.
import type { MachineId, ThreadRef } from "@fleetd/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ExecutorError } from "./Executors.ts";

export interface ThreadChanges {
  readonly branch?: string;
  readonly worktreePath?: string;
  /** Repo-relative paths any of the thread's checkpoints touched, sorted and unique. */
  readonly paths: ReadonlyArray<string>;
  /** Pull requests T3 linked to the thread. */
  readonly pullRequestUrls: ReadonlyArray<string>;
}

export class ThreadWorkspace extends Context.Service<
  ThreadWorkspace,
  {
    /** The repo's default local branch at `cwd`, else its current branch. */
    readonly defaultBranch: (machineId: MachineId, cwd: string) => Effect.Effect<string, ExecutorError>;
    readonly changes: (ref: ThreadRef) => Effect.Effect<ThreadChanges, ExecutorError>;
    /** What the thread is waiting on a human for, if anything: a question or an approval prompt. */
    readonly pendingQuestion: (ref: ThreadRef) => Effect.Effect<string | undefined, ExecutorError>;
  }
>()("fleetd/executor/ThreadWorkspace") {}
