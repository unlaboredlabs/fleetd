// A project's setup commands: run in order in a new worktree before its
// agent starts, each with `sh -c`, the project's (and order's) variables and a 10 minute limit, until one fails. The
// agent starts either way and hears what failed. A worktree set up before is not set up again while its commands and the contents of the files setup names as
// its inputs are unchanged: the digest is kept in the worktree's own git directory, which goes when the worktree does.
// Nor where the agent's box starts from its bot's computer image (../place/image.ts), which ran the same commands with the
// same inputs, unless they wrote into the checkout, which an image doesn't hold.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Place } from "../place/index.ts";
import type { Env } from "../util.ts";
import type { WorktreeSetup } from "../../shared/contracts.ts";
import { timeoutOf, type FromImage, type Outcome, type Plan, type Ran } from "./setup_words.ts";

const MARKER = "fleetd-setup";

export { how, note, SETUP_TIMEOUT_SEC, timeoutOf, type FromImage, type Outcome, type Plan, type Ran } from "./setup_words.ts";

const ok = (r: Ran) => r.exitCode === 0;

/** The git directory of the worktree at `cwd`: `.git` itself, or where a linked worktree's `.git` file points. */
function gitDir(cwd: string): string | undefined {
  const dot = join(cwd, ".git");
  try {
    if (statSync(dot).isDirectory()) return dot;
    const target = readFileSync(dot, "utf8")
      .split("\n")
      .find((l) => l.startsWith("gitdir: "))
      ?.slice(8)
      .trim();
    return target ? (isAbsolute(target) ? target : join(cwd, target)) : undefined;
  } catch {
    return undefined;
  }
}

/** The digest of the commands and of each input file's contents; undefined when setup names no inputs (it always runs). */
export function digest(setup: WorktreeSetup, cwd: string): string | undefined {
  const inputs = setup.inputs ?? [];
  if (!inputs.length) return undefined;
  const hash = createHash("sha256");
  for (const command of setup.commands ?? []) hash.update("command\0").update(command).update("\0");
  for (const input of inputs) {
    hash.update("input\0").update(input);
    try {
      const bytes = readFileSync(join(cwd, input));
      hash.update("\0present\0").update(createHash("sha256").update(bytes).digest());
    } catch {
      hash.update("\0absent\0");
    }
  }
  return hash.digest("hex");
}

export const reusable = (cwd: string, d: string) => {
  const dir = gitDir(cwd);
  try {
    return !!dir && readFileSync(join(dir, MARKER), "utf8").trim() === d;
  } catch {
    return false;
  }
};

/** Records that the worktree at `cwd` was set up with this digest; none clears it. */
export function record(cwd: string, d: string | undefined): void {
  const dir = gitDir(cwd);
  if (!dir) return;
  try {
    if (d) writeFileSync(join(dir, MARKER), `${d}\n`);
    else if (existsSync(join(dir, MARKER))) rmSync(join(dir, MARKER));
  } catch (error) {
    console.warn(`setup digest not saved for ${cwd}: ${String(error)}`);
  }
}

/** Runs the commands in order in `cwd`, where the agent runs (`place`), stopping at the first that fails; `signal`
 * kills the one running. */
export async function run(
  place: Place,
  setup: Plan,
  cwd: string,
  env: Env,
  scrub: string[],
  started: (i: number) => void,
  ended: (i: number, ran: Ran) => void,
  signal?: AbortSignal,
  image?: FromImage,
): Promise<Outcome> {
  const d = digest(setup, cwd);
  if (image && !image.worktree && (setup.commands ?? []).length) {
    record(cwd, d);
    return { kind: "image", builtAt: image.builtAt };
  }
  if (d && reusable(cwd, d)) return { kind: "reused" };
  const commands = setup.commands ?? [];
  const ran: Ran[] = [];
  for (const [i, command] of commands.entries()) {
    if (signal?.aborted) break;
    started(i);
    const at = Date.now();
    const outcome = await place.run({ cwd, argv: ["sh", "-c", command], timeoutSec: timeoutOf(setup), env, scrub, ...(signal ? { signal } : {}) });
    const one: Ran = { command, exitCode: outcome.exitCode, outputTail: outcome.notRun ?? outcome.outputTail, timedOut: outcome.timedOut, tookMs: Date.now() - at };
    ended(i, one);
    ran.push(one);
    if (!ok(one)) {
      record(cwd, undefined);
      return { kind: "failed", ran, skipped: commands.slice(i + 1) };
    }
  }
  record(cwd, d);
  return { kind: "done", ran };
}
