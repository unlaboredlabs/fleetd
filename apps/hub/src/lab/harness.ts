// Shared plumbing for `pnpm test:lab` scenarios: process control by captured PID, a real MCP client, and
// helpers that wait on hub events instead of sleeping. Never used in CI.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const LAB = process.env.FLEETD_LAB ?? path.join(os.homedir(), "src/fleetd-lab");
export const T3_SRC = process.env.T3_SRC ?? path.join(LAB, "t3-src");
export const HUB_PORT = Number(process.env.FLEETD_LAB_HUB_PORT ?? 4795);
export const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
/** Per hub port, so two runs on different ports never delete each other's state. */
export const RUN = process.env.FLEETD_LAB_RUN ?? path.join(LAB, `e2e-${HUB_PORT}`);
/** The bundled CLI (`pnpm test:lab` builds it first), so the lab exercises what ships, lead prompt included. */
export const CLI = path.join(REPO, "apps/cli/dist/bin.js");
export const MODEL = "claude-haiku-5-5";
/** The hub's offline-queue TTL in lab runs, short enough for the expiry check to wait it out. */
export const QUEUE_TTL_SEC = 40;
export const MACHINES = [
  { id: "lab-a", t3Home: path.join(LAB, "home-a"), t3Url: "http://127.0.0.1:4711" },
  { id: "lab-b", t3Home: path.join(LAB, "home-b"), t3Url: "http://127.0.0.1:4712" },
] as const;
export type LabMachine = (typeof MACHINES)[number]["id"];

if (path.resolve(LAB).startsWith(path.join(os.homedir(), ".t3"))) throw new Error("refusing: lab dir is inside ~/.t3");

export type Body = Record<string, any>;

/** Children get HOME, PATH, USER and LANG only: never this session's CLAUDE* variables. */
export const scrubbedEnv = () =>
  Object.fromEntries(["HOME", "PATH", "USER", "LANG"].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));

const t0 = Date.now();
export const log = (line: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}\n`);
export const ok = (line: string) => log(`ok  ${line}`);
export const check = (cond: unknown, what: string): void => {
  if (!cond) throw new Error(`check failed: ${what}`);
};

/** Retries `probe` until it returns a value. Probes long-poll events_wait, so this does not spin. */
export async function until<A>(what: string, ms: number, probe: () => Promise<A | undefined>): Promise<A> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
  }
  throw new Error(`timed out after ${ms / 1000}s: ${what}`);
}

export const cli = (...args: Array<string>) =>
  execFileSync(process.execPath, [CLI, ...args], { env: scrubbedEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Mints a 1 h session on a lab T3 with its own CLI, as the node would. */
export const mintT3Bearer = (machine: { readonly t3Home: string }) =>
  execFileSync(
    process.execPath,
    [path.join(T3_SRC, "apps/server/src/bin.ts"), "auth", "session", "issue", "--base-dir", machine.t3Home, "--ttl", "1h", "--label", "fleetd-lab", "--token-only"],
    { env: scrubbedEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  )
    .trim()
    .split("\n")
    .at(-1)!
    .trim();

export const lab = (command: "up" | "down", instance: string) =>
  execFileSync(process.execPath, [path.join(REPO, "lab/lab.mjs"), command, instance], { env: scrubbedEnv(), encoding: "utf8" });

const started: Array<{ name: string; child: ChildProcess }> = [];

/** Starts `fleetd <args>` with the scrubbed environment plus `env`, logging to RUN/logs/<name>.log. */
export const startCli = (name: string, args: Array<string>, env: Record<string, string> = {}) => {
  fs.mkdirSync(path.join(RUN, "logs"), { recursive: true });
  const out = fs.openSync(path.join(RUN, "logs", `${name}.log`), "a");
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...scrubbedEnv(), ...env }, stdio: ["ignore", out, out] });
  started.push({ name, child });
  log(`started ${name} pid=${child.pid}`);
  return child;
};

/** Stops the newest process started under `name`, by the PID captured at spawn. */
export const stopCli = async (name: string) => {
  const entry = started.findLast((s) => s.name === name);
  if (!entry || entry.child.exitCode !== null || entry.child.signalCode !== null) return;
  const exited = new Promise((r) => entry.child.once("exit", r));
  const startedMs = Date.now();
  entry.child.kill("SIGTERM");
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    entry.child.kill("SIGKILL");
  }, 10_000);
  await exited;
  clearTimeout(timer);
  log(`stopped ${name} pid=${entry.child.pid} (${killed ? "SIGKILL after 10 s" : `SIGTERM, exited in ${Date.now() - startedMs} ms`})`);
};

export const isRunning = (name: string) => {
  const entry = started.findLast((s) => s.name === name);
  return entry !== undefined && entry.child.exitCode === null && entry.child.signalCode === null;
};

export const stopAll = async () => {
  for (const name of [...new Set(started.map((s) => s.name))].toReversed()) await stopCli(name);
};

/** Everything a scenario gets. It also satisfies the narrower contexts the scenario files declare. */
export interface Lab {
  readonly hubUrl: string;
  readonly hubHome: string;
  /** An operate key on every machine. */
  readonly key: string;
  /** Scratch directory for one scenario; it may not exist yet. */
  readonly dir: string;
  readonly callTool: (name: string, args?: Record<string, unknown>) => Promise<{ readonly isError: boolean; readonly body: Body }>;
  readonly log: typeof log;
  readonly ok: typeof ok;
  readonly check: typeof check;
  readonly until: typeof until;
  readonly startCli: typeof startCli;
  readonly stopCli: typeof stopCli;
  /** Stops the machine's node by its PID. */
  readonly stopNode: (machineId: LabMachine) => Promise<void>;
  /** Starts the machine's node again (`node run`, since it has joined). */
  readonly startNode: (machineId: LabMachine) => void;
  /** (Re)starts the hub on the same home and port with `env` added, waits for /healthz and reconnects the MCP client. */
  readonly startHub: (env?: Readonly<Record<string, string>>) => Promise<void>;
  /** Stops the hub by its PID, leaving nodes and T3 running. */
  readonly stopHub: () => Promise<void>;
  readonly machines: typeof MACHINES;
  /** A short-lived bearer for a lab T3 itself, to watch it while the hub is down. */
  readonly mintT3Bearer: (machine: { readonly t3Home: string }) => string;
  /** Waits for the first event after `cursor` that matches, long-polling events_wait. */
  readonly waitEvent: (
    what: string,
    ms: number,
    filter: { readonly cursor: number; readonly types?: ReadonlyArray<string>; readonly machineId?: string; readonly match?: (e: Body) => boolean },
  ) => Promise<{ readonly event: Body; readonly cursor: number }>;
  /** Waits until the machine is online with a live T3 connection (its project reads are not stale). */
  readonly waitLive: (machineId: LabMachine) => Promise<void>;
  /** A thread on the machine whose run has finished, launching one tiny turn if there is none. */
  readonly idleThread: (machineId: LabMachine) => Promise<{ readonly threadId: string; readonly projectId: string }>;
  /** The hub's current event cursor. */
  readonly cursor: () => Promise<number>;
}

export const callToolWith =
  (client: () => Client): Lab["callTool"] =>
  async (name, args = {}) => {
    const result = await client().callTool({ name, arguments: args }, undefined, { timeout: 70_000 });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    return { isError: result.isError === true, body: JSON.parse(text) as Body };
  };

export const waitEventWith =
  (callTool: Lab["callTool"]): Lab["waitEvent"] =>
  async (what, ms, filter) => {
    let cursor = filter.cursor;
    const event = await until(what, ms, async () => {
      const page = (
        await callTool("events_wait", {
          cursor,
          timeoutSec: 50,
          ...(filter.types === undefined ? {} : { types: filter.types }),
          ...(filter.machineId === undefined ? {} : { machineId: filter.machineId }),
        })
      ).body;
      const found = (page.events as Array<Body>).find((e) => filter.match?.(e) ?? true);
      cursor = found === undefined ? page.cursor : found.seq;
      return found;
    });
    return { event, cursor };
  };

/** Launches one tiny haiku turn ("reply OK") and returns its thread id. */
export const launchTiny = async (lab: Pick<Lab, "callTool" | "check">, machineId: LabMachine, projectId: string, title: string) => {
  const launched = await lab.callTool("thread_launch", {
    machineId,
    projectId,
    prompt: "Reply with the single word OK and nothing else.",
    model: MODEL,
    effort: "low",
    title,
    clientRequestId: randomUUID(),
  });
  lab.check(!launched.isError, `thread_launch succeeded: ${JSON.stringify(launched.body)}`);
  return launched.body.threadId as string;
};
