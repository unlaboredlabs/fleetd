// `git patch-id --stable` of a PR head's diff against its merge base with the PR's base branch, run by the node on the
// project's machine. A rebase that applies cleanly keeps it, so reviews bound to it survive the train's rebase.
import type { MachineId } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { NodeCommands } from "../checks/NodeCommands.ts";

export interface PatchIdInput {
  readonly machineId: MachineId;
  /** The project's checkout on that machine; the fetched refs land under refs/fleetd/reviews/. */
  readonly cwd: string;
  readonly base: string;
  readonly prNumber: number;
  readonly sha: string;
}

export class PatchIdError extends Data.TaggedError("PatchIdError")<{ readonly message: string }> {}

export class PatchIds extends Context.Service<
  PatchIds,
  { readonly compute: (input: PatchIdInput) => Effect.Effect<string, PatchIdError> }
>()("fleetd/reviews/PatchIds") {}

// Positional arguments, never interpolated: $1 base branch, $2 PR number, $3 head SHA.
const SCRIPT = [
  "set -eu",
  'git fetch -q --no-tags origin "+refs/heads/$1:refs/fleetd/reviews/base/$1" "+refs/pull/$2/head:refs/fleetd/reviews/pull/$2"',
  'mb=$(git merge-base "$3" "refs/fleetd/reviews/base/$1")',
  'git diff --no-color --no-ext-diff --no-textconv "$mb" "$3" | git patch-id --stable',
].join("\n");

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

/** The argv the node runs, or why the input is refused. */
export const patchIdArgv = (input: Pick<PatchIdInput, "base" | "prNumber" | "sha">): ReadonlyArray<string> | string => {
  if (!SHA.test(input.sha)) return `not a full commit SHA: ${input.sha.slice(0, 80)}`;
  if (!BRANCH.test(input.base) || input.base.includes("..")) return `not a branch name: ${input.base.slice(0, 80)}`;
  if (!Number.isInteger(input.prNumber) || input.prNumber < 1) return `not a PR number: ${input.prNumber}`;
  return ["sh", "-c", SCRIPT, "fleetd-patch-id", input.base, String(input.prNumber), input.sha];
};

/** `git patch-id` prints "<patch id> <commit id>"; the commit id is zeros for a diff read from stdin. */
export const parsePatchId = (output: string): string | undefined => {
  for (const line of output.split("\n")) {
    const id = /^([0-9a-f]{40}|[0-9a-f]{64}) [0-9a-f]+$/u.exec(line.trim())?.[1];
    if (id !== undefined) return id;
  }
  return undefined;
};

export const make = Effect.map(NodeCommands, (commands) =>
  PatchIds.of({
    compute: (input) =>
      Effect.gen(function* () {
        const argv = patchIdArgv(input);
        if (typeof argv === "string") return yield* new PatchIdError({ message: argv });
        const where = `#${input.prNumber} at ${input.sha.slice(0, 12)} on ${input.machineId}`;
        const out = yield* commands
          .run(input.machineId, { cwd: input.cwd, argv, timeoutSec: 300 })
          .pipe(Effect.mapError((e) => new PatchIdError({ message: `patch id of ${where}: ${e.message}` })));
        const id = out.exitCode === 0 ? parsePatchId(out.outputTail) : undefined;
        if (id !== undefined) return id;
        const tail = out.outputTail.trim().split("\n").slice(-3).join(" | ");
        const why = out.exitCode === 0 ? "the diff against its merge base is empty" : `exit ${out.exitCode ?? "none"}`;
        return yield* new PatchIdError({ message: `patch id of ${where}: ${why}${tail === "" ? "" : `: ${tail}`}`.slice(0, 500) });
      }),
  }),
);

/** Needs NodeCommands. */
export const layer = Layer.effect(PatchIds, make);
