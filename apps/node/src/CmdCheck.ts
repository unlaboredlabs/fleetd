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

/**
 * Runs one `cmd_check` and always answers it. `exitCode` is null when the command timed out, died of a signal, could
 * not start, or was refused; `outputTail` then says which. Interrupting the effect kills the process group too.
 */
export const runCmdCheck = (frame: CmdCheck, roots: ReadonlyArray<string>): Effect.Effect<CmdResult> =>
  Effect.callback<CmdResult>((resume, signal) => {
    const reply = (exitCode: number | null, output: string, timedOut = false): CmdResult => ({
      t: "cmd_result",
      id: frame.id,
      exitCode,
      outputTail: output.slice(-OUTPUT_TAIL_MAX),
      timedOut,
    });
    const where = confine(frame.cwd, roots);
    if (!where.ok) return resume(Effect.succeed(reply(null, `fleetd node refused to run this: ${where.why}`)));

    const [command = "", ...args] = frame.argv;
    // Its own process group, so a timeout also kills whatever the command started.
    const child = spawn(command, args, { cwd: where.dir, env: scrubbedEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    // Keeps a little more than the tail so a multi-chunk tail is never cut short.
    const push = (chunk: string) => {
      output = (output + chunk).slice(-2 * OUTPUT_TAIL_MAX);
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
    }, frame.timeoutSec * 1000);
    signal.addEventListener("abort", killGroup, { once: true });
    const settle = (result: CmdResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", killGroup);
      resume(Effect.succeed(result));
    };

    child.once("error", (error) => {
      if (child.pid === undefined) settle(reply(null, `could not start ${command}: ${error.message}`));
    });
    child.once("close", (code, killedBy) => {
      const noted = (note: string) => (output === "" ? note : `${output.replace(/\n$/u, "")}\n${note}`);
      if (timedOut) return settle(reply(null, noted(`[fleetd: killed after ${frame.timeoutSec} s]`), true));
      if (code === null) return settle(reply(null, noted(`[fleetd: ended by ${killedBy ?? "a signal"}]`)));
      settle(reply(code, output));
    });
  });
