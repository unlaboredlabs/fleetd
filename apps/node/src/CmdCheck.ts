// `cmd_check` frames from the hub: run argv (never through a shell) in a directory under the node's command roots,
// kill the whole process group at the timeout, and reply with the exit code and the tail of the output.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CmdCheck, CmdResult } from "@fleetd/contracts";
import { Effect } from "effect";
import { scrubbedEnv } from "./T3Sessions.ts";

export const OUTPUT_TAIL_MAX = 2000;

const isWithin = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

const realpath = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
};

/** The real directory `cwd` names, when it lies under one of `roots` after following symlinks on both sides. */
export const confine = (
  cwd: string,
  roots: ReadonlyArray<string>,
): { readonly ok: true; readonly dir: string } | { readonly ok: false; readonly why: string } => {
  const dir = realpath(cwd);
  if (dir === undefined) return { ok: false, why: `${cwd} does not exist on this machine` };
  if (!fs.statSync(dir).isDirectory()) return { ok: false, why: `${cwd} is not a directory` };
  const realRoots = roots.flatMap((root) => realpath(root) ?? []);
  if (!realRoots.some((root) => isWithin(root, dir))) {
    return { ok: false, why: `${cwd} is outside the directories this node runs commands in (${roots.join(", ")})` };
  }
  return { ok: true, dir };
};

export interface ConfinedRun {
  readonly cwd: string;
  readonly argv: ReadonlyArray<string>;
  readonly timeoutSec: number;
  /** The child's whole environment. Default: the scrubbed node environment. */
  readonly env?: NodeJS.ProcessEnv;
  /** Values replaced by `[secret]` in the output, so they never leave the node. */
  readonly scrub?: ReadonlyArray<string>;
}

export interface RunOutcome {
  readonly exitCode: number | null;
  /** Scrubbed, at most OUTPUT_TAIL_MAX characters, with a note on how it ended when it did not exit on its own. */
  readonly outputTail: string;
  readonly timedOut: boolean;
  /** Why it never ran: a cwd outside the roots, or a command that could not start. */
  readonly notRun?: string;
}

const SCRUBBED = "[secret]";

/** Every occurrence of each value replaced, longest first so a value inside another cannot leave a piece behind. */
export const scrubValues = (text: string, values: ReadonlyArray<string>) =>
  [...values].filter((value) => value.length > 0).sort((a, b) => b.length - a.length).reduce((out, value) => out.replaceAll(value, SCRUBBED), text);

/**
 * Runs argv (never through a shell) in a directory under `roots`, killing the whole process group at the timeout.
 * Interrupting the effect kills the process group too.
 */
export const runConfined = (run: ConfinedRun, roots: ReadonlyArray<string>): Effect.Effect<RunOutcome> =>
  Effect.callback<RunOutcome>((resume, signal) => {
    const scrub = run.scrub ?? [];
    const longest = Math.max(0, ...scrub.map((value) => value.length));
    const where = confine(run.cwd, roots);
    if (!where.ok) return resume(Effect.succeed({ exitCode: null, outputTail: "", timedOut: false, notRun: `fleetd node refused to run this: ${where.why}` }));

    const [command = "", ...args] = run.argv;
    // Its own process group, so a timeout also kills whatever the command started.
    const child = spawn(command, args, { cwd: where.dir, env: run.env ?? scrubbedEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    // Keeps a little more than the tail so a multi-chunk tail is never cut short, and scrubs before trimming so a
    // secret split across chunks is whole when it is replaced; only a value still arriving can be at the end.
    const push = (chunk: string) => {
      output = scrubValues(output + chunk, scrub).slice(-(2 * OUTPUT_TAIL_MAX + longest));
    };
    child.stdout.setEncoding("utf8").on("data", push);
    child.stderr.setEncoding("utf8").on("data", push);

    let timedOut = false;
    let settled = false;
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, run.timeoutSec * 1000);
    signal.addEventListener("abort", killGroup, { once: true });
    const settle = (exitCode: number | null, note?: string, notRun?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", killGroup);
      const text = scrubValues(note === undefined ? output : output === "" ? note : `${output.replace(/\n$/u, "")}\n${note}`, scrub);
      resume(Effect.succeed({ exitCode, outputTail: text.slice(-OUTPUT_TAIL_MAX), timedOut, ...(notRun === undefined ? {} : { notRun }) }));
    };

    child.once("error", (error) => {
      if (child.pid === undefined) settle(null, undefined, `could not start ${command}: ${error.message}`);
    });
    child.once("close", (code, killedBy) => {
      if (timedOut) return settle(null, `[fleetd: killed after ${run.timeoutSec} s]`);
      if (code === null) return settle(null, `[fleetd: ended by ${killedBy ?? "a signal"}]`);
      settle(code);
    });
  });

/**
 * Runs one `cmd_check` and always answers it. `exitCode` is null when the command timed out, died of a signal, could
 * not start, or was refused; `outputTail` then says which.
 */
export const runCmdCheck = (frame: CmdCheck, roots: ReadonlyArray<string>): Effect.Effect<CmdResult> =>
  Effect.map(runConfined(frame, roots), (outcome) => ({
    t: "cmd_result",
    id: frame.id,
    exitCode: outcome.exitCode,
    outputTail: outcome.notRun ?? outcome.outputTail,
    timedOut: outcome.timedOut,
  }));
