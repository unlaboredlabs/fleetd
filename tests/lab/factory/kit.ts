// The factory lab's harness: one hub and one node of the fleetd under test, on a project that isn't fleetd
// (project.ts), with the offline claude stand-in (fakeClaude.ts) first on the node's PATH. Everything lives in one
// run dir; every process is started here and stopped by the PID captured at spawn, along with whatever it started.
// No network and no GitHub, so it runs in CI. The helpers are what the W9 scenarios share: add the project, spawn
// writers, kill or stop and start the node, wait for a task's state, read `fleetd status`, metrics_get and the lead's
// digest, and check the person's checkout is byte for byte as they left it.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Body, callToolWith, check, descendants, fleetdCommand, type Lead, leadIn, log, ok, openWorkstream, type ProcInfo, sleep, stillRuns, until, waitEventWith } from "../harness.ts";
import { createProject, type Project, stateDiff, treeBytes } from "./project.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MACHINE = "factory-a";
const TASK_EVENTS = ["task.queued", "task.started", "task.idle", "task.completed", "task.failed", "task.cancelled"];

export interface Factory {
  readonly dir: string;
  readonly hubUrl: string;
  readonly project: Project;
  readonly ref: { readonly machineId: string; readonly projectId: string };
  readonly callTool: ReturnType<typeof callToolWith>;
  readonly waitEvent: ReturnType<typeof waitEventWith>;
  readonly cursor: () => Promise<number>;
  readonly until: typeof until;
  /** fleetd's lead tools as the project's lead calls them, through the node's socket in the project's root. */
  readonly lead: Lead;
  /** Opens a workstream (an order) the harness drives itself; returns its id. */
  readonly workstream: (title: string) => string;
  /** Spawns a writer under `workstreamId` with spawn_agent; returns the task as spawned. */
  readonly spawnWriter: (workstreamId: string, title: string, prompt: string) => Body;
  readonly task: (taskId: string) => Promise<Body>;
  /** Every event after `cursor` (of `types`, if given), in hub order. */
  readonly eventsSince: (cursor: number, types?: ReadonlyArray<string>) => Promise<Array<Body>>;
  /** The project's agents the slot board counts as running now. */
  readonly running: () => Promise<number>;
  /** Waits until the task is in one of `states`; fails at once if it ends in another. */
  readonly waitTask: (taskId: string, states: ReadonlyArray<string>, ms?: number) => Promise<Body>;
  /** SIGKILL, a crash: its sessions are orphaned until it starts again. */
  readonly killNode: () => Promise<void>;
  /** SIGTERM, a graceful stop. */
  readonly stopNode: () => Promise<void>;
  /** Starts the node again and waits for its link to be live. */
  readonly startNode: () => Promise<void>;
  readonly nodePid: () => number | undefined;
  /** `fleetd status` as the person reads it (`json: true`: its --json). */
  readonly status: (opts?: { readonly json?: boolean }) => string;
  /** metrics_get for the project, since `since` (default 7 days ago). */
  readonly metrics: (since?: Date) => Promise<{ readonly isError: boolean; readonly body: Body }>;
  /** Starts (or restarts, fresh) the project's lead and returns the digest its first turn was given. */
  readonly leadDigest: () => Promise<string>;
  /** The user messages a session was given, in order, as filed by the claude stand-in. */
  readonly messages: (threadId: string) => Array<string>;
  /** The node's own summary of a session (its branch, worktree, recreatedFrom), read from its store. */
  readonly sessionSummary: (threadId: string) => Body | undefined;
  /** Records the person's checkout byte for byte; `unchanged()` fails, naming the paths, when anything differs. */
  readonly humanCheckout: () => { readonly unchanged: (why: string) => void };
}

interface Proc {
  readonly name: string;
  readonly child: ChildProcess;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });

/**
 * Sets up the run under `dir` (which must be empty or missing), runs `body`, and stops everything it started however
 * `body` ends.
 */
export async function withFactory(dir: string, body: (f: Factory) => Promise<void>) {
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  const procs: Array<Proc> = [];
  /** Processes the node started (sessions, their tools), recorded before each stop so none outlives the run. */
  const sessions: Array<ProcInfo> = [];

  const start = (name: string, args: Array<string>, env: Record<string, string>) => {
    const logFile = fs.openSync(path.join(dir, "logs", `${name}.log`), "a");
    const [bin, argv] = fleetdCommand(args);
    const child = spawn(bin, argv, { env, stdio: ["ignore", logFile, logFile] });
    fs.closeSync(logFile);
    procs.push({ name, child });
    log(`started ${name} pid=${child.pid}`);
    return child;
  };
  const live = (name: string) => procs.findLast((p) => p.name === name && p.child.exitCode === null && p.child.signalCode === null);
  const stop = async (name: string, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
    const p = live(name);
    if (p === undefined) return;
    const exited = new Promise((r) => p.child.once("exit", r));
    const timer = setTimeout(() => p.child.kill("SIGKILL"), 15_000);
    p.child.kill(signal);
    await exited;
    clearTimeout(timer);
    log(`stopped ${name} pid=${p.child.pid} (${signal})`);
  };

  // `claude` on the node's PATH is the stand-in; `fleetd` is the build under test, for the agents' shells.
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec '${process.execPath}' '${path.join(HERE, "fakeClaude.ts")}' "$@"\n`, { mode: 0o755 });
  const [fleetdBin, fleetdPrefix] = fleetdCommand([]);
  fs.writeFileSync(path.join(bin, "fleetd"), `#!/bin/sh\nexec ${[fleetdBin, ...fleetdPrefix].map((a) => `'${a}'`).join(" ")} "$@"\n`, { mode: 0o755 });
  const PATH = `${bin}:${process.env.PATH ?? ""}`;
  const env = (home: string): Record<string, string> => ({ HOME: home, PATH, LANG: "C.UTF-8", USER: process.env.USER ?? "lab" });

  const project = createProject(dir);
  // The machine user's HOME holds their checkout (the node's default command root) and their git identity.
  const machineHome = path.dirname(project.root);
  const nodeHome = path.join(machineHome, ".fleetd/node");
  fs.mkdirSync(path.join(machineHome, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(machineHome, ".gitconfig"), "[user]\n\tname = lab agent\n\temail = agent@lab.invalid\n[init]\n\tdefaultBranch = main\n");
  const nodeEnv = { ...env(machineHome), ANTHROPIC_API_KEY: "lab-offline" };

  const hubHome = path.join(dir, "hub");
  const hubEnv = env(path.join(dir, "hub-user"));
  fs.mkdirSync(hubEnv.HOME!, { recursive: true });
  const port = await freePort();
  const hubUrl = `http://127.0.0.1:${port}`;
  const cli = (...args: Array<string>) => execFileSync(...fleetdCommand(args), { env: hubEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  let client: Client | undefined;
  try {
    start("hub", ["hub", "start", "--home", hubHome, "--listen", `127.0.0.1:${port}`], hubEnv);
    await until("hub /healthz", 60_000, async () => {
      const up = await fetch(`${hubUrl}/healthz`).then((r) => r.ok, () => false);
      return up ? true : (await sleep(250), undefined);
    });
    const key = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", hubHome, "--name", "factory", "--role", "operate", "--machines", "*"))?.[0];
    check(key, "hub key create printed a key");
    const keyFile = path.join(dir, "read.key");
    cli("hub", "key", "create", "--home", hubHome, "--name", "factory-status", "--role", "read", "--machines", "*", "--out", keyFile);
    client = new Client({ name: "fleetd-factory-lab", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${hubUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }) as Transport);
    const callTool = callToolWith(() => client!);
    const waitEvent = waitEventWith(callTool);
    const cursor = async () => (await callTool("fleetd_status")).body.cursor as number;
    ok(`hub up on ${hubUrl}`);

    const token = /--code (\S+)/u.exec(cli("pair", "--worker", MACHINE, "--home", hubHome))?.[1];
    check(token, "pair --worker printed an enrollment code");
    start(`node-${MACHINE}`, ["node", "join", "--hub", hubUrl, "--token", token!, "--machine", MACHINE, "--home", nodeHome], nodeEnv);

    /** Online, and once it has the project, with a live session link (the project's reads aren't stale). */
    let projectId: string | undefined;
    const waitLive = () =>
      until(`${MACHINE} online`, 120_000, async () => {
        const s = (await callTool("fleetd_status")).body;
        const online = (s.machines as Array<Body>).some((m) => m.machineId === MACHINE && m.status === "online");
        if (online && (projectId === undefined || (await callTool("project_get", { machineId: MACHINE, projectId })).body.stale === false)) return true;
        await callTool("events_wait", { cursor: s.cursor, timeoutSec: 2 });
        return undefined;
      });
    await waitLive();
    const added = await until("project_add", 60_000, async () => {
      const out = await callTool("project_add", { machineId: MACHINE, path: project.root, title: "inventory" });
      return out.isError ? (await sleep(500), undefined) : out.body;
    });
    projectId = added.projectId as string;
    const ref = { machineId: MACHINE, projectId };
    // Its writers run on medium, which a new project allows only once it picks it.
    await until("project_set medium", 60_000, async () => {
      const out = await callTool("project_set", { ...ref, profiles: ["medium"] });
      return out.isError ? (await sleep(500), undefined) : out.body;
    });
    ok(`project ${ref.projectId}: ${project.root}, origin ${execFileSync("git", ["remote", "get-url", "origin"], { cwd: project.root, encoding: "utf8" }).trim()}`);

    const nodeSock = path.join(nodeHome, "node.sock");
    const lead = leadIn(project.root, { HOME: machineHome, PATH, FLEETD_NODE_SOCK: nodeSock });
    const nodePid = () => live(`node-${MACHINE}`)?.child.pid;
    const recordSessions = () => {
      const pid = nodePid();
      if (pid !== undefined) sessions.push(...descendants(pid));
    };
    const task = async (taskId: string) => (await callTool("task_get", { taskId })).body.task as Body;
    const sessionsDir = path.join(machineHome, ".claude/projects");

    const factory: Factory = {
      dir,
      hubUrl,
      project,
      ref,
      callTool,
      waitEvent,
      cursor,
      until,
      lead,
      workstream: (title) => openWorkstream(check, lead, title, { why: "the factory lab", doneWhen: ["the harness closes it"] }),
      spawnWriter: (workstreamId, title, prompt) => {
        const out = lead("spawn_agent", { workstreamId, title, kind: "write", profile: "medium", prompt });
        check(out.code === 0 && typeof out.result?.task?.taskId === "string", `spawn_agent ${title}: ${out.text}`);
        return out.result!.task as Body;
      },
      task,
      eventsSince: async (from, types) => {
        const all: Array<Body> = [];
        for (let c = from; ; ) {
          const page = (await callTool("events_wait", { cursor: c, timeoutSec: 0, ...(types === undefined ? {} : { types }) })).body;
          all.push(...(page.events as Array<Body>));
          if (page.more !== true) return all;
          c = page.cursor as number;
        }
      },
      running: async () => {
        const perProject = ((await callTool("fleetd_status")).body.slots?.perProject ?? []) as Array<Body>;
        return (perProject.find((p) => p.projectRef?.machineId === MACHINE && p.projectRef?.projectId === projectId)?.running as number | undefined) ?? 0;
      },
      waitTask: async (taskId, states, ms = 120_000) => {
        let from = await cursor();
        return until(`${taskId} ${states.join(" or ")}`, ms, async () => {
          const t = await task(taskId);
          if (states.includes(t.state as string)) return t;
          check(!["done", "failed", "cancelled"].includes(t.state as string), `${taskId} ended ${t.state}, not ${states.join(" or ")}: ${JSON.stringify(t.result ?? t)}`);
          from = (await callTool("events_wait", { cursor: from, types: TASK_EVENTS, timeoutSec: 5 })).body.cursor as number;
          return undefined;
        });
      },
      killNode: async () => {
        recordSessions();
        await stop(`node-${MACHINE}`, "SIGKILL");
      },
      stopNode: async () => {
        recordSessions();
        await stop(`node-${MACHINE}`);
      },
      startNode: async () => {
        // A quick restart may relink before the hub ever saw it offline, so the node's own log says when it is back.
        const logPath = path.join(dir, "logs", `node-${MACHINE}.log`);
        const offset = fs.statSync(logPath).size;
        start(`node-${MACHINE}`, ["node", "run", "--home", nodeHome], nodeEnv);
        await until(`${MACHINE} relinked`, 120_000, async () =>
          fs.readFileSync(logPath, "utf8").slice(offset).includes("linked to hub") ? true : (await sleep(250), undefined),
        );
        await waitLive();
      },
      nodePid,
      status: (opts = {}) =>
        execFileSync(...fleetdCommand(["status", "--hub", hubUrl, "--key-file", keyFile, ...(opts.json === true ? ["--json"] : [])]), {
          env: { ...hubEnv, FLEETD_HOME: path.join(dir, "status-home") },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      metrics: (since = new Date(Date.now() - 7 * 86_400_000)) => callTool("metrics_get", { projectRef: ref, since: since.toISOString(), tz: "UTC" }),
      leadDigest: async () => {
        const from = await cursor();
        let started = await callTool("lead_start", { ...ref, fresh: true });
        if (started.isError && started.body.code === "not_found") started = await callTool("lead_start", ref);
        check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
        const threadId = started.body.threadId as string;
        await waitEvent("the lead's first turn ends", 120_000, {
          cursor: from,
          types: ["thread.completed", "thread.failed", "thread.interrupted"],
          match: (e) => e.threadId === threadId,
        });
        const first = factory.messages(threadId)[0];
        check(first, `the lead's session ${threadId} was given a first message`);
        return first!;
      },
      messages: (threadId) => {
        if (!fs.existsSync(sessionsDir)) return [];
        return fs.readdirSync(sessionsDir).flatMap((d) => {
          const file = path.join(sessionsDir, d, `${threadId}.jsonl`);
          if (!fs.existsSync(file)) return [];
          return fs
            .readFileSync(file, "utf8")
            .split("\n")
            .filter((l) => l.startsWith("{"))
            .map((l) => JSON.parse(l) as Body)
            .filter((e) => e.type === "user")
            .map((e) => e.message.content as string);
        });
      },
      sessionSummary: (threadId) => {
        const db = new DatabaseSync(path.join(nodeHome, "sessions.sqlite"), { readOnly: true });
        try {
          const row = db.prepare("SELECT summary FROM sessions WHERE id = ?").get(threadId) as { summary: string } | undefined;
          return row === undefined ? undefined : (JSON.parse(row.summary) as Body);
        } finally {
          db.close();
        }
      },
      humanCheckout: () => {
        const before = treeBytes(project.human);
        return {
          unchanged: (why) => {
            const diff = stateDiff(before, treeBytes(project.human));
            check(diff.length === 0, `the person's checkout is byte for byte as they left it (${why}); differs: ${diff.slice(0, 20).join(", ")}`);
          },
        };
      },
    };
    await body(factory);
  } finally {
    await client?.close().catch(() => undefined);
    const nodePid = live(`node-${MACHINE}`)?.child.pid;
    if (nodePid !== undefined) sessions.push(...descendants(nodePid));
    for (const p of procs.toReversed()) await stop(p.name);
    // What the node started and left behind (a killed node's sessions, until a restart reaps them).
    for (const p of sessions.filter(stillRuns)) {
      try {
        process.kill(p.pid, "SIGKILL");
        log(`killed leftover ${p.cmdline.slice(0, 3).join(" ")} pid=${p.pid}`);
      } catch {
        // Gone meanwhile.
      }
    }
  }
}
