// The train's git, run on the project's machine through its node (`cmd_check` frames) in a hub-owned worktree of
// the project's checkout. Every command is argv, never a shell line, except the one pipe for the patch id, whose refs
// go in as positional arguments.
import type { MachineId } from "@fleetd/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { NodeCommands } from "../checks/NodeCommands.ts";

export class GitError extends Data.TaggedError("GitError")<{ readonly message: string }> {}

export interface GitTarget {
  readonly machineId: MachineId;
  /** The project's checkout; the train worktree is added from it. */
  readonly root: string;
  readonly worktree: string;
}

/** The default train worktree: `<parent of the checkout>/.fleetd-train/<checkout name>`. */
export const defaultWorktree = (root: string) => {
  const trimmed = root.replace(/\/+$/u, "");
  const slash = trimmed.lastIndexOf("/");
  return `${trimmed.slice(0, slash) || ""}/.fleetd-train/${trimmed.slice(slash + 1)}`;
};

// Rebased commits get a fixed committer and are never signed; the squash merge on GitHub replaces them anyway.
const IDENTITY = ["-c", "user.name=fleetd train", "-c", "user.email=train@fleetd.invalid", "-c", "commit.gpgsign=false"];

const tail = (text: string) => text.trim().split("\n").slice(-6).join("\n").slice(-600);

export const make = (commands: NodeCommands["Service"], target: GitTarget) => {
  const exec = (argv: ReadonlyArray<string>, options: { readonly cwd?: string; readonly timeoutSec?: number } = {}) =>
    commands.run(target.machineId, { cwd: options.cwd ?? target.worktree, argv, timeoutSec: options.timeoutSec ?? 120 }).pipe(
      Effect.mapError((e) => new GitError({ message: `${argv.slice(0, 3).join(" ")} on ${target.machineId}: ${e.message}` })),
    );

  /** Fails unless it exits 0; returns the output. */
  const ok = (argv: ReadonlyArray<string>, options?: { readonly cwd?: string; readonly timeoutSec?: number }) =>
    Effect.flatMap(exec(argv, options), (out) =>
      out.exitCode === 0
        ? Effect.succeed(out.outputTail)
        : Effect.fail(new GitError({ message: `${argv.slice(0, 3).join(" ")} failed${out.timedOut ? " (timed out)" : ""}: ${tail(out.outputTail)}` })),
    );

  const ensureWorktree = Effect.gen(function* () {
    const there = yield* exec(["git", "-C", target.worktree, "rev-parse", "--is-inside-work-tree"], { cwd: target.root });
    if (there.exitCode === 0) return;
    yield* ok(["git", "worktree", "prune"], { cwd: target.root });
    yield* ok(["git", "worktree", "add", "--detach", target.worktree], { cwd: target.root });
  });

  const fetch = (base: string, branch: string) =>
    ok(["git", "fetch", "--no-tags", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
      timeoutSec: 300,
    });

  const revParse = (ref: string) =>
    Effect.flatMap(ok(["git", "rev-parse", "--verify", `${ref}^{commit}`]), (out) => {
      const sha = /^([0-9a-f]{40}|[0-9a-f]{64})$/mu.exec(out)?.[1];
      return sha === undefined ? Effect.fail(new GitError({ message: `git rev-parse ${ref} printed no SHA` })) : Effect.succeed(sha);
    });

  /** `git patch-id --stable` of `head`'s diff against its merge base with `base`. */
  const patchId = (base: string, head: string) =>
    Effect.flatMap(ok(["sh", "-c", 'git diff "$1...$2" | git patch-id --stable', "sh", base, head]), (out) => {
      const id = /^([0-9a-f]{40}|[0-9a-f]{64}) /mu.exec(out)?.[1];
      return id === undefined ? Effect.fail(new GitError({ message: `${head} has no changes against ${base}` })) : Effect.succeed(id);
    });

  return {
    /** Fetches the base and the PR branch into `origin/*` and says where the branch points and its patch id. */
    inspect: (base: string, branch: string) =>
      Effect.gen(function* () {
        yield* ensureWorktree;
        yield* fetch(base, branch);
        const headSha = yield* revParse(`origin/${branch}`);
        return { headSha, patchId: yield* patchId(`origin/${base}`, headSha) };
      }),

    /**
     * Rebases the fetched PR branch onto `origin/<base>` in the train worktree. On a conflict the rebase is aborted
     * and the conflicting paths come back.
     */
    rebase: (base: string, branch: string) =>
      Effect.gen(function* () {
        yield* ensureWorktree;
        yield* fetch(base, branch);
        // Whatever an earlier run left behind goes first.
        yield* exec(["git", "rebase", "--abort"]);
        yield* ok(["git", "checkout", "--force", "--detach", `origin/${branch}`]);
        yield* ok(["git", "clean", "-fdq"]);
        const remoteHead = yield* revParse("HEAD");
        const rebased = yield* exec(["git", ...IDENTITY, "rebase", "--no-autosquash", `origin/${base}`], { timeoutSec: 600 });
        if (rebased.exitCode !== 0) {
          const unmerged = yield* exec(["git", "diff", "--name-only", "--diff-filter=U"]);
          yield* exec(["git", "rebase", "--abort"]);
          const paths = unmerged.exitCode === 0 ? unmerged.outputTail.split("\n").map((p) => p.trim()).filter((p) => p !== "") : [];
          return { _tag: "conflict" as const, remoteHead, paths, output: tail(rebased.outputTail) };
        }
        const headSha = yield* revParse("HEAD");
        return { _tag: "rebased" as const, remoteHead, headSha, patchId: yield* patchId(`origin/${base}`, headSha) };
      }),

    /** Pushes the rebased HEAD to the PR branch, only if the branch is still at `expected`. */
    push: (branch: string, expected: string) =>
      Effect.map(
        exec(["git", "push", `--force-with-lease=refs/heads/${branch}:${expected}`, "origin", `HEAD:refs/heads/${branch}`], { timeoutSec: 300 }),
        (out) => (out.exitCode === 0 ? { pushed: true as const } : { pushed: false as const, output: tail(out.outputTail) }),
      ),
  };
};

export type TrainGit = ReturnType<typeof make>;
