// The files a task branch changes as its PR would show them: `git diff --name-only <merge-base>..<branch>`, run by
// the node in the project's checkout. Unlike T3's checkpoint paths, a writer that rebased onto a newer base is not
// charged with the base's files.
import type { MachineId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import type { NodeCommands } from "../checks/NodeCommands.ts";

// Positional arguments, never interpolated: $1 base branch, $2 task branch. The merge base is taken against
// origin/<base> when that is newer than the local base, since a writer rebases onto what it fetched.
const SCRIPT = [
  "set -eu",
  'mb=$(git merge-base "refs/heads/$2" "refs/heads/$1")',
  'if o=$(git merge-base "refs/heads/$2" "refs/remotes/origin/$1" 2>/dev/null) && git merge-base --is-ancestor "$mb" "$o"; then mb=$o; fi',
  'git -c core.quotePath=false diff --name-only --no-renames "$mb" "refs/heads/$2"',
].join("\n");

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
/** The node keeps this much of the output; a list that fills it may have lost its first names. */
const OUTPUT_MAX = 2000;

export const branchDiffArgv = (base: string, branch: string): ReadonlyArray<string> | undefined =>
  [base, branch].every((b) => BRANCH.test(b) && !b.includes(".."))
    ? ["sh", "-c", SCRIPT, "fleetd-branch-diff", base, branch]
    : undefined;

/**
 * The branch's changed paths, sorted; undefined when the node could not say in full (offline, unknown branch, a
 * list longer than the output it keeps).
 */
export const branchDiff = (
  commands: NodeCommands["Service"],
  input: { readonly machineId: MachineId; readonly cwd: string; readonly base: string; readonly branch: string },
) =>
  Effect.gen(function* () {
    const argv = branchDiffArgv(input.base, input.branch);
    if (argv === undefined) return undefined;
    const out = yield* commands.run(input.machineId, { cwd: input.cwd, argv, timeoutSec: 60 });
    if (out.exitCode !== 0 || out.outputTail.length >= OUTPUT_MAX) return undefined;
    return out.outputTail
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .toSorted();
  }).pipe(Effect.orElseSucceed(() => undefined));
