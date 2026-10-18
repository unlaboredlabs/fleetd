// Shared plumbing for the lab scenarios (`npm run lab`): process control by captured PID, a real MCP client, and
// helpers that wait on hub events instead of sleeping. Never used in CI.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import pin from "../../vendor/t3/pin.json" with { type: "json" };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../..");
/** The lab T3 control script (start, stop, status of lab-a and lab-b). */
export const LAB_SCRIPT = path.join(HERE, "lab.mjs");
const T3_PIN = pin.commit;
const LAB_ROOT = process.env.FLEETD_LAB ?? path.join(os.homedir(), "src/fleetd-lab");
/**
 * FLEETD_LAB_SLOT=<n> (0-9, default 0) is an independent lab that can run beside the others. Slot 0 is the lab root
 * itself, slot n lives in <root>/slot-<n> (T3 homes, Claude config dirs, test repos, run dirs, lock), and every lab port
 * is the slot-0 port + 20 * n. The slot-0 ports, 4711/4712 (T3 lab-a/lab-b), 4781 (cmd check), 4783 (m8 secrets), 4784
 * (hub unit), 4795 (hub), 4796 (degraded/watchdog hub) and 4797 (m12), all differ mod 20, so slots 0-9 never collide
 * and stay within 4711-4977. lab.mjs applies the same scheme. The pinned T3 source worktree is shared read-only.
 */
export const SLOT = Number(process.env.FLEETD_LAB_SLOT ?? 0);
if (!Number.isInteger(SLOT) || SLOT < 0 || SLOT > 9) throw new Error(`FLEETD_LAB_SLOT must be 0-9, got ${process.env.FLEETD_LAB_SLOT}`);
export const LAB = SLOT === 0 ? LAB_ROOT : path.join(LAB_ROOT, `slot-${SLOT}`);
export const slotPort = (slot0Port: number) => slot0Port + 20 * SLOT;
/** T3 from source at the pin (lab.mjs runs the same checkout). */
export const T3_SRC = process.env.T3_SRC ?? path.join(LAB_ROOT, `t3-src-${T3_PIN.slice(0, 10)}`);
export const HUB_PORT = Number(process.env.FLEETD_LAB_HUB_PORT ?? slotPort(4795));
export const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
/** Per hub port, so two runs on different ports never delete each other's state. */
export const RUN = process.env.FLEETD_LAB_RUN ?? path.join(LAB, `e2e-${HUB_PORT}`);
/** Cargo's release output, honouring CARGO_TARGET_DIR as cargo does. */
export const RELEASE = path.join(process.env.CARGO_TARGET_DIR ?? path.join(REPO, "target"), "release");
/** The release build of the binary (`cargo build --release -p fleetd`), so the lab exercises what ships. */
export const CLI = path.join(RELEASE, "fleetd");
/**
 * The command for one fleetd invocation. FLEETD_BIN (default the release build) is the fleetd under test; FLEETD_HUB_BIN,
 * FLEETD_NODE_BIN and FLEETD_CLI_BIN override it for `hub …`, `node …` and everything else, for mixed runs such as
 * two builds side by side. A .js/.mjs/.cjs/.ts bin runs under this node; any other bin is executed directly.
 */
export const fleetdCommand = (args: ReadonlyArray<string>): [string, Array<string>] => {
  const own = args[0] === "hub" ? process.env.FLEETD_HUB_BIN : args[0] === "node" ? process.env.FLEETD_NODE_BIN : process.env.FLEETD_CLI_BIN;
  const given = own ?? process.env.FLEETD_BIN ?? CLI;
  // Some callers spawn with another cwd, so a relative path is resolved here.
  const bin = given.includes("/") ? path.resolve(given) : given;
  return /\.[cm]?[jt]s$/u.test(bin) ? [process.execPath, [bin, ...args]] : [bin, [...args]];
};
export const MODEL = "claude-haiku-5-5";

// Texts the binary emits that scenarios match on; each mirrors a constant in crates/fleetd.
/** `hub/leads/prompt.rs` LEAD_PROMPT_VERSION. */
export const LEAD_PROMPT_VERSION = "v4";
/** `hub/playbooks/finish_all_rules.rs` FINISH_ALL_IDLE. */
export const FINISH_ALL_IDLE = "finish-all: nothing left with a value source";
/** `hub/watchdog/ladder.rs` NUDGE. */
export const NUDGE = "You seem stalled; continue the task from where you stopped.";

/** Receiver-side Standard Webhooks check: a `v1` HMAC-SHA256 over `id.timestamp.body`, timestamp within 5 min. */
export const verifySignature = (secret: string, headers: Record<string, string>, body: string, nowSec: number): boolean => {
  const timestamp = Number(headers["webhook-timestamp"]);
  if (!Number.isInteger(timestamp) || Math.abs(nowSec - timestamp) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/u, ""), "base64");
  const expected = Buffer.from(`v1,${createHmac("sha256", key).update(`${headers["webhook-id"]}.${timestamp}.${body}`).digest("base64")}`);
  return (headers["webhook-signature"] ?? "").split(" ").some((given) => given.length === expected.length && timingSafeEqual(Buffer.from(given), expected));
};
/** The hub's offline-queue TTL in lab runs, short enough for the expiry check to wait it out. */
export const QUEUE_TTL_SEC = 40;
export const MACHINES = [
  { id: "lab-a", t3Home: path.join(LAB, "home-a"), t3Url: `http://127.0.0.1:${slotPort(4711)}` },
  { id: "lab-b", t3Home: path.join(LAB, "home-b"), t3Url: `http://127.0.0.1:${slotPort(4712)}` },
] as const;
export type LabMachine = (typeof MACHINES)[number]["id"];

if (path.resolve(LAB).startsWith(path.join(os.homedir(), ".t3"))) throw new Error("refusing: lab dir is inside ~/.t3");

export type Body = Record<string, any>;

/** Children get HOME, PATH, USER and LANG only: never this session's CLAUDE* variables. */
export const scrubbedEnv = () =>
  Object.fromEntries(["HOME", "PATH", "USER", "LANG"].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));

/** The user's own `claude` login from ~/.claude/settings.json, for process env only (never a file, argv or log). */
export const claudeLoginEnv = (): Record<string, string> => {
  const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude/settings.json"), "utf8")) as { env?: Record<string, unknown> };
  return Object.fromEntries(
    ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"].flatMap((k) => (typeof settings.env?.[k] === "string" && settings.env[k] !== "" ? [[k, settings.env[k] as string]] : [])),
  );
};

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
  execFileSync(...fleetdCommand(args), { env: scrubbedEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

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

/** What lab.mjs needs to find this slot's lab, for the processes that run it. */
export const labEnv = (): Record<string, string> =>
  Object.fromEntries(["FLEETD_LAB", "FLEETD_LAB_SLOT", "T3_SRC"].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));

export const lab = (command: "up" | "down", instance: string) =>
  execFileSync(process.execPath, [LAB_SCRIPT, command, instance], { env: { ...scrubbedEnv(), ...labEnv() }, encoding: "utf8" });

const LOCK = path.join(LAB, "test-lab.lock");

/** One lab run per slot at a time (test:lab, site-capture): they share the slot's T3 instances, and one run's cleanup stops them. */
export const takeLabLock = () => {
  fs.mkdirSync(LAB, { recursive: true });
  try {
    const holder = Number(fs.readFileSync(LOCK, "utf8").trim());
    if (holder > 0 && fs.existsSync(`/proc/${holder}`)) throw new Error(`another lab run (pid ${holder}) holds ${LOCK}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.writeFileSync(LOCK, `${process.pid}\n`);
  process.once("exit", () => fs.rmSync(LOCK, { force: true }));
};

const started: Array<{ name: string; child: ChildProcess }> = [];

/** Starts `fleetd <args>` with the scrubbed environment plus `env`, logging to RUN/logs/<name>.log. */
export const startCli = (name: string, args: Array<string>, env: Record<string, string> = {}) => {
  fs.mkdirSync(path.join(RUN, "logs"), { recursive: true });
  const out = fs.openSync(path.join(RUN, "logs", `${name}.log`), "a");
  const child = spawn(...fleetdCommand(args), { env: { ...scrubbedEnv(), ...env }, stdio: ["ignore", out, out] });
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
    const send = () => client().callTool({ name, arguments: args }, undefined, { timeout: 70_000 });
    const result = await send()
      // After a few idle seconds the hub's HTTP server may close the kept-alive socket just as the next request goes
      // out on it; that request never reached the hub, so it is sent once more.
      .catch((error: unknown) => (/other side closed/u.test(String((error as Error).cause)) ? send() : Promise.reject(error)))
      .catch((error: unknown) => {
        // The SDK's "fetch failed" names neither the tool nor why.
        const cause = error instanceof Error && error.cause !== undefined ? ` (${String(error.cause)})` : "";
        throw new Error(`MCP ${name} failed: ${error instanceof Error ? error.message : String(error)}${cause}`);
      });
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
