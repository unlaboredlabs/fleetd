// A project's setup commands: run in order in a new worktree before its
// agent starts, each with `sh -c`, the project's (and order's) variables and the project's time limit, until one
// fails. A worktree set up before is not set up again while its commands and the contents of the files setup names as
// its inputs are unchanged: the digest is kept in the worktree's own git directory, which goes when the worktree does.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { runConfined } from "../cmd/index.ts";
import { tailUtf16, type Env } from "../util.ts";
import type { WorktreeSetup } from "../../shared/contracts.ts";

const MARKER = "fleetd-setup";
export const SETUP_TIMEOUT_DEFAULT_SEC = 600;

export type Ran = { command: string; exitCode: number | null; outputTail: string; timedOut: boolean; tookMs: number };
export type Outcome = { kind: "done"; ran: Ran[] } | { kind: "reused" } | { kind: "failed"; ran: Ran[]; skipped: string[] };

const ok = (r: Ran) => r.exitCode === 0;
/** "exited 1 after 12 s", "passed its 600 s limit", "ended by a signal after 3 s". */
export const how = (r: Ran, timeoutSec: number) =>
  r.timedOut ? `passed its ${timeoutSec} s limit` : r.exitCode !== null ? `exited ${r.exitCode} after ${Math.floor(r.tookMs / 1000)} s` : `ended by a signal after ${Math.floor(r.tookMs / 1000)} s`;

export const timeoutOf = (setup: WorktreeSetup) => setup.timeoutSec ?? SETUP_TIMEOUT_DEFAULT_SEC;

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

/** Runs the commands in order in `cwd`, stopping at the first that fails; `signal` kills the one running. */
export async function run(
  setup: WorktreeSetup,
  cwd: string,
  env: Env,
  scrub: string[],
  started: (i: number) => void,
  ended: (i: number, ran: Ran) => void,
  signal?: AbortSignal,
): Promise<Outcome> {
  const d = digest(setup, cwd);
  if (d && reusable(cwd, d)) return { kind: "reused" };
  const commands = setup.commands ?? [];
  const ran: Ran[] = [];
  for (const [i, command] of commands.entries()) {
    if (signal?.aborted) break;
    started(i);
    const at = Date.now();
    const outcome = await runConfined({ cwd, argv: ["sh", "-c", command], timeoutSec: timeoutOf(setup), env, scrub, ...(signal ? { signal } : {}) }, [cwd]);
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

const code = (command: string) => (command.includes("`") ? `\`\`${command}\`\`` : `\`${command}\``);
const tail = (text: string, max: number) => tailUtf16(text.trimEnd(), max);

/** What the agent hears first about setup. `again`: it ran before the agent went on, not before it started. */
export function note(outcome: Outcome, timeoutSec: number, again: boolean): string | undefined {
  const when = again ? "before you went on" : "before you started";
  if (outcome.kind === "reused") return "Setup did not run again: this worktree was set up before with the same commands and inputs.";
  if (outcome.kind === "done")
    return outcome.ran.length ? `Setup ran in this worktree ${when}: ${outcome.ran.map((r) => `${code(r.command)} (${how(r, timeoutSec)})`).join(", ")}.` : undefined;
  const last = outcome.ran[outcome.ran.length - 1];
  if (!last) return undefined;
  let text = `Setup failed in this worktree ${when}, and the project starts its agents anyway: ${code(last.command)} ${how(last, timeoutSec)}.`;
  if (outcome.skipped.length) text += ` Not run after it: ${outcome.skipped.map(code).join(", ")}.`;
  return `${text} The end of its output:\n\`\`\`\n${tail(last.outputTail, 1500)}\n\`\`\`\nFix what you need, or tell your lead if you can't.`;
}

/** Why the start failed: the command, how it ended and the end of its output. */
export function failure(outcome: Outcome, timeoutSec: number): string | undefined {
  if (outcome.kind !== "failed") return undefined;
  const last = outcome.ran[outcome.ran.length - 1];
  if (!last) return undefined;
  let text = `setup failed, so the agent did not start: ${code(last.command)} ${how(last, timeoutSec)}`;
  if (outcome.skipped.length) text += `; ${outcome.skipped.length} not run after it`;
  return `${text}. Fix the project's setup commands (Settings › Projects) or turn on "Start the agent anyway". The end of its output:\n${tail(last.outputTail, 3000)}`;
}
