// `cmd_check` frames from the hub: run argv, never through a shell, in a directory
// under the node's command roots, kill the whole process group at the timeout, and reply with the exit code and the
// tail of the output.
import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { sep } from "node:path";
import { constants } from "node:os";
import { errnoName, gitCommandEnv, scrubbedEnv, tailUtf16, type Env } from "../util.ts";
import type { CmdCheck, CmdResult } from "../wire.ts";

export const OUTPUT_TAIL_MAX = 2000;
const SCRUBBED = "[secret]";
/** How a `cmd_result`'s output starts when the node refused the command. */
export const REFUSED = "fleetd node refused to run this: ";

const under = (dir: string, root: string) => dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);

/** The real directory `cwd` names, when it lies under one of `roots` after following symlinks on both sides. */
export function confine(cwd: string, roots: string[]): string | { refused: string } {
  let dir: string;
  try {
    dir = realpathSync(cwd);
  } catch {
    return { refused: `${cwd} does not exist on this machine` };
  }
  if (!statSync(dir).isDirectory()) return { refused: `${cwd} is not a directory` };
  const inside = roots.some((root) => {
    try {
      return under(dir, realpathSync(root));
    } catch {
      return false;
    }
  });
  if (!inside) return { refused: `${cwd} is outside cmdRoots, the directories this node runs commands in (${roots.join(", ")})` };
  return dir;
}

/** Every occurrence of each value replaced, longest first so a value inside another cannot leave a piece behind. */
export function scrubValues(text: string, values: string[]): string {
  return values
    .filter((v) => v !== "")
    .sort((a, b) => b.length - a.length)
    .reduce((out, value) => out.split(value).join(SCRUBBED), text);
}

export type ConfinedRun = {
  cwd: string;
  argv: string[];
  timeoutSec: number;
  /** The child's whole environment. Default: the scrubbed node environment. */
  env?: Env;
  /** Values replaced by `[secret]` in the output, so they never leave the node. */
  scrub?: string[];
  /** Kills the run's process group: a lost link takes its commands with it. */
  signal?: AbortSignal;
};

export type RunOutcome = { exitCode: number | null; outputTail: string; timedOut: boolean; notRun?: string };

/** Runs argv in a directory under `roots`, in a process group of its own killed at the timeout. */
export function runConfined(run: ConfinedRun, roots: string[]): Promise<RunOutcome> {
  const scrub = run.scrub ?? [];
  const longest = Math.max(0, ...scrub.map((s) => s.length));
  const dir = confine(run.cwd, roots);
  if (typeof dir !== "string") return Promise.resolve({ exitCode: null, outputTail: "", timedOut: false, notRun: `${REFUSED}${dir.refused}` });
  const [command = "", ...args] = run.argv;
  return new Promise<RunOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd: dir, env: run.env ?? scrubbedEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (error) {
      const code = errnoName(error) ?? String(error);
      return resolve({ exitCode: null, outputTail: "", timedOut: false, notRun: `could not start ${command}: spawn ${command} ${code}` });
    }
    let output = "";
    let timedOut = false;
    let settled = false;
    // Keeps a little more than the tail, and scrubs before trimming, so a secret split across chunks is whole when it
    // is replaced.
    const keep = 2 * OUTPUT_TAIL_MAX + longest;
    const push = (chunk: string) => {
      output = tailUtf16(scrubValues(output + chunk, scrub), keep);
    };
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const decoderOut = new TextDecoder();
    const decoderErr = new TextDecoder();
    child.stdout!.on("data", (b: Buffer) => push(decoderOut.decode(b, { stream: true })));
    child.stderr!.on("data", (b: Buffer) => push(decoderErr.decode(b, { stream: true })));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, run.timeoutSec * 1000);
    const abort = () => killGroup();
    run.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = errnoName(error) ?? String(error);
      resolve({ exitCode: null, outputTail: "", timedOut: false, notRun: `could not start ${command}: spawn ${command} ${code}` });
    });
    // "close": the process has exited and every pipe has closed.
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal?.removeEventListener("abort", abort);
      push(decoderOut.decode() + decoderErr.decode());
      let note: string | undefined;
      let exitCode: number | null = code;
      if (timedOut) {
        note = `[fleetd: killed after ${run.timeoutSec} s]`;
        exitCode = null;
      } else if (code === null) {
        const name = signal && signal in constants.signals ? signal : "a signal";
        note = `[fleetd: ended by ${name}]`;
      }
      const text = note === undefined ? output : output === "" ? note : `${output.replace(/\n$/, "")}\n${note}`;
      resolve({ exitCode, outputTail: tailUtf16(scrubValues(text, scrub), OUTPUT_TAIL_MAX), timedOut });
    });
  });
}

/** Runs one `cmd_check` and always answers it. On a node whose home is `home`, the command gets it as
 * `FLEETD_NODE_HOME`. */
export async function runCmdCheck(frame: CmdCheck, roots: string[], home?: string, signal?: AbortSignal): Promise<CmdResult> {
  const git = frame.argv[0] === "git";
  const env = home !== undefined ? { ...(git ? gitCommandEnv() : scrubbedEnv()), FLEETD_NODE_HOME: home } : git ? gitCommandEnv() : undefined;
  const outcome = await runConfined({ cwd: frame.cwd, argv: frame.argv, timeoutSec: frame.timeoutSec, env, signal }, roots);
  return {
    id: frame.id,
    exitCode: outcome.exitCode,
    outputTail: outcome.notRun === undefined ? outcome.outputTail : tailUtf16(outcome.notRun, OUTPUT_TAIL_MAX),
    timedOut: outcome.timedOut,
  };
}
