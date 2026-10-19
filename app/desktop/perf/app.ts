// Launches the built app (or FLEETD_PERF_APP, a packaged executable) for a measurement: its own temporary state,
// a scrubbed environment, its stderr as lines, and stop/RSS by the PID it spawned.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { account, parsePs, parseTopMem, tree } from "./memory.ts";
import { desktopDir } from "./targets.ts";

/** The Electron binary; requiring the package downloads it on first use (pnpm runs no postinstall). */
const electronBinary = (): string => createRequire(import.meta.url)("electron") as string;

export interface Launched {
  readonly child: ChildProcess;
  readonly dir: string;
  readonly lines: ReadonlyArray<string>;
  /** The first stderr line matching `pattern`, waiting up to `timeoutMs`. */
  waitFor(pattern: RegExp, timeoutMs: number): Promise<RegExpMatchArray>;
  /** The app's whole process tree, MB: summed RSS, and unique memory (shared pages counted once). */
  memory(): Memory;
  stop(): Promise<void>;
}

export interface LaunchOptions {
  readonly env?: Record<string, string>;
  /** Opens a DevTools port for Playwright's connectOverCDP; startup stays free of a debugger either way. */
  readonly debug?: boolean;
  /** Runs Electron on this app instead of ours (perf/reference), whatever FLEETD_PERF_APP says. */
  readonly entry?: string;
}

export const launch = (options: LaunchOptions = {}): Launched => {
  const dir = mkdtempSync(path.join(tmpdir(), "fleetd-perf-"));
  const env: Record<string, string> = {
    FLEETD_HOME: path.join(dir, "fleetd"),
    FLEETD_PERF: "1",
    LANG: "en_US.UTF-8",
    ...options.env,
  };
  // Only what Electron needs: never the user's fleetd state or the agent's own session variables.
  for (const key of ["HOME", "PATH", "USER", "TMPDIR", "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]) {
    const value = process.env[key];
    if (value !== undefined && env[key] === undefined) env[key] = value;
  }
  const fixture = process.env["FLEETD_PERF_FIXTURE"];
  if (fixture !== undefined && fixture !== "") Object.assign(env, { FLEETD_FIXTURE: fixture, FLEETD_FIXTURE_DIR: path.join(desktopDir, "fixtures") });
  const packaged = process.env["FLEETD_PERF_APP"];
  const args = [`--user-data-dir=${path.join(dir, "chromium")}`];
  if (options.debug === true) args.push("--remote-debugging-port=0");
  if (process.platform === "linux") {
    // No SUID sandbox helper on CI runners or a dev box; the renderer sandbox (webPreferences) stays on.
    args.push("--no-sandbox");
    if (env["DISPLAY"] === undefined && env["WAYLAND_DISPLAY"] === undefined) args.push("--ozone-platform=headless");
  }
  const child =
    options.entry !== undefined
      ? spawn(electronBinary(), [options.entry, ...args], { env, stdio: ["ignore", "ignore", "pipe"] })
      : packaged !== undefined && packaged !== ""
      ? spawn(packaged, args, { env, stdio: ["ignore", "ignore", "pipe"] })
      : spawn(electronBinary(), [desktopDir, ...args], { env, stdio: ["ignore", "ignore", "pipe"] });
  const lines: Array<string> = [];
  const waiters = new Set<() => void>();
  let partial = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    const parts = (partial + text).split("\n");
    partial = parts.pop() ?? "";
    lines.push(...parts);
    for (const wake of waiters) wake();
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  void exited.then(() => {
    for (const wake of waiters) wake();
  });

  return {
    child,
    dir,
    lines,
    waitFor: (pattern, timeoutMs) =>
      new Promise((resolve, reject) => {
        const check = () => {
          for (const line of lines) {
            const match = pattern.exec(line);
            if (match !== null) return done(() => resolve(match));
          }
          if (child.exitCode !== null || child.signalCode !== null) done(() => reject(new Error(`the app exited before ${String(pattern)}:\n${lines.slice(-20).join("\n")}`)));
        };
        const timer = setTimeout(() => done(() => reject(new Error(`no ${String(pattern)} within ${timeoutMs} ms:\n${lines.slice(-20).join("\n")}`))), timeoutMs);
        const done = (settle: () => void) => {
          clearTimeout(timer);
          waiters.delete(check);
          settle();
        };
        waiters.add(check);
        check();
      }),
    memory() {
      const procs = tree(parsePs(execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,args="], { encoding: "utf8" })), child.pid ?? -1);
      const sum = account(procs, deduplicatedKb(procs.map((p) => p.pid)), alive);
      return { uniqueMb: sum.uniqueKb / 1024, rssMb: sum.rssKb / 1024, processes: sum.processes, kinds: sum.kinds };
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        await exited;
        clearTimeout(timer);
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

export interface Memory {
  readonly rssMb: number;
  readonly uniqueMb: number;
  readonly processes: number;
  readonly kinds: ReadonlyArray<string>;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** KB per pid it could read: PSS on Linux, the physical footprint (top's MEM) on macOS. */
const deduplicatedKb = (pids: ReadonlyArray<number>): Map<number, number> => {
  if (process.platform !== "linux") return parseTopMem(execFileSync("top", ["-l", "1", "-stats", "pid,mem"], { encoding: "utf8" }));
  const read = new Map<number, number>();
  for (const pid of pids) {
    try {
      const pss = /^Pss:\s+(\d+)/mu.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))?.[1];
      if (pss !== undefined) read.set(pid, Number(pss));
    } catch {
      // Unread: account() fails the measurement unless the process has exited.
    }
  }
  return read;
};

export const devtoolsPort = async (app: Launched): Promise<number> =>
  Number((await app.waitFor(/DevTools listening on ws:\/\/[^:]+:(\d+)\//u, 30_000))[1]);

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
