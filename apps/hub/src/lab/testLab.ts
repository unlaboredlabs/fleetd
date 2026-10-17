// `pnpm test:lab`: the M1 "done when" scenario, end to end, against the disposable lab (never in CI).
// Two stock T3 instances (lab/up.sh), one hub and two nodes, driven only through a real MCP client.
// Costs one tiny claude-haiku-5-5 turn. Every process this starts is stopped by the PID captured at spawn.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const LAB = process.env.FLEETD_LAB ?? path.join(os.homedir(), "src/fleetd-lab");
const T3_SRC = process.env.T3_SRC ?? path.join(LAB, "t3-src");
const HUB_PORT = Number(process.env.FLEETD_LAB_HUB_PORT ?? 4795);
const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
const RUN = path.join(LAB, "e2e");
const CLI = path.join(REPO, "apps/cli/src/bin.ts");
const MODEL = "claude-haiku-5-5";
const MACHINES = [
  { id: "lab-a", t3Home: path.join(LAB, "home-a"), t3Url: "http://127.0.0.1:4711" },
  { id: "lab-b", t3Home: path.join(LAB, "home-b"), t3Url: "http://127.0.0.1:4712" },
] as const;

if (path.resolve(LAB).startsWith(path.join(os.homedir(), ".t3"))) throw new Error("refusing: lab dir is inside ~/.t3");

/** Children get HOME, PATH, USER and LANG only: never this session's CLAUDE* variables. */
const scrubbedEnv = () =>
  Object.fromEntries(["HOME", "PATH", "USER", "LANG"].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));

const started: Array<{ name: string; child: ChildProcess }> = [];
const t0 = Date.now();
const log = (line: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}\n`);
const ok = (line: string) => log(`ok  ${line}`);
const check = (cond: unknown, what: string): void => {
  if (!cond) throw new Error(`check failed: ${what}`);
};

const cli = (...args: Array<string>) =>
  execFileSync(process.execPath, [CLI, ...args], { env: scrubbedEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const startProcess = (name: string, args: Array<string>) => {
  fs.mkdirSync(path.join(RUN, "logs"), { recursive: true });
  const out = fs.openSync(path.join(RUN, "logs", `${name}.log`), "w");
  const child = spawn(process.execPath, [CLI, ...args], { env: scrubbedEnv(), stdio: ["ignore", out, out] });
  started.push({ name, child });
  log(`started ${name} pid=${child.pid}`);
  return child;
};

const stopProcess = async (name: string) => {
  const entry = started.find((s) => s.name === name);
  if (!entry || entry.child.exitCode !== null || entry.child.signalCode !== null) return;
  const exited = new Promise((r) => entry.child.once("exit", r));
  entry.child.kill("SIGTERM");
  const timer = setTimeout(() => entry.child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
  log(`stopped ${name} pid=${entry.child.pid}`);
};

const lab = (command: "up" | "down", instance: string) =>
  execFileSync(process.execPath, [path.join(REPO, "lab/lab.mjs"), command, instance], { env: scrubbedEnv(), encoding: "utf8" });

async function until<A>(what: string, ms: number, probe: () => Promise<A | undefined>): Promise<A> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
  }
  throw new Error(`timed out after ${ms / 1000}s: ${what}`);
}

type Body = Record<string, any>;
const callTool = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 70_000 });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { isError: result.isError === true, body: JSON.parse(text) as Body };
};

async function main() {
  // Only instances this run started are stopped at the end; one already running is left as found.
  const labStarted: Array<string> = [];
  for (const m of MACHINES) {
    const out = lab("up", m.id);
    if (/already running/u.test(out)) ok(`${m.id} T3 already running (left running)`);
    else {
      labStarted.push(m.id);
      ok(`${m.id} T3 up: ${out.trim()}`);
    }
  }

  try {
    fs.rmSync(RUN, { recursive: true, force: true });
    const hubHome = path.join(RUN, "hub");
    startProcess("hub", ["hub", "start", "--home", hubHome, "--listen", `127.0.0.1:${HUB_PORT}`]);
    await until("hub /healthz", 30_000, async () => {
      try {
        return (await fetch(`${HUB_URL}/healthz`)).ok ? true : undefined;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
        return undefined;
      }
    });
    ok(`hub up on ${HUB_URL}`);

    const key = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", hubHome, "--name", "lab", "--role", "operate", "--machines", "*"))?.[0];
    check(key, "hub key create printed a key");
    for (const m of MACHINES) {
      const token = /^\S{16,}$/mu.exec(cli("hub", "token", "create", "--home", hubHome, "--machine", m.id))?.[0];
      check(token, `enrollment token for ${m.id}`);
      startProcess(`node-${m.id}`, [
        "node", "join", "--hub", HUB_URL, "--token", token!, "--machine", m.id, "--t3-home", m.t3Home, "--t3-url", m.t3Url,
        "--t3-cmd", `${process.execPath} ${path.join(T3_SRC, "apps/server/src/bin.ts")}`, "--home", path.join(RUN, `node-${m.id}`),
      ]);
    }

    const client = new Client({ name: "fleetd-test-lab", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${HUB_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }) as Transport,
    );
    ok(`MCP client connected; ${(await client.listTools()).tools.length} tools`);

    // 1. Both machines online, with lab-b's project cached.
    let cursor = 0;
    const status = await until("both machines online with projects", 120_000, async () => {
      const s = (await callTool(client, "fleetd_status")).body;
      const online = s.machines.filter((m: Body) => m.status === "online").map((m: Body) => m.machineId);
      if (online.length === 2 && s.projects.some((p: Body) => p.machineId === "lab-b") && s.projects.some((p: Body) => p.machineId === "lab-a")) return s;
      cursor = (await callTool(client, "events_wait", { cursor: s.cursor, timeoutSec: 5 })).body.cursor;
      return undefined;
    });
    ok(`fleetd_status: ${status.machines.map((m: Body) => `${m.machineId}=${m.status}`).join(", ")}; ${status.projects.length} projects`);
    cursor = status.cursor;

    // 2. Launch on lab-b.
    const projectB = status.projects.find((p: Body) => p.machineId === "lab-b");
    const projectA = status.projects.find((p: Body) => p.machineId === "lab-a");
    const launched = await callTool(client, "thread_launch", {
      machineId: "lab-b",
      projectId: projectB.projectId,
      prompt: "Reply with the single word OK and nothing else.",
      model: MODEL,
      effort: "low",
      title: "fleetd test:lab",
      clientRequestId: randomUUID(),
    });
    check(!launched.isError, `thread_launch succeeded: ${JSON.stringify(launched.body)}`);
    const threadId = launched.body.threadId as string;
    ok(`thread_launch lab-b/${projectB.projectId} ${MODEL} effort=low -> ${threadId}`);

    // 3. Wait for its completion through events_wait.
    const done = await until("thread.completed for the launched thread", 240_000, async () => {
      const page = (await callTool(client, "events_wait", { cursor, machineId: "lab-b", timeoutSec: 50 })).body;
      cursor = page.cursor;
      return page.events.find((e: Body) => e.threadId === threadId && e.type !== "thread.started");
    });
    check(done.type === "thread.completed", `thread ended with ${done.type}: ${done.summary}`);
    ok(`events_wait: ${done.type} seq=${done.seq} "${done.summary}"`);

    // 4. Read the reply.
    const outcome = (await callTool(client, "project_get", { machineId: "lab-b", projectId: projectB.projectId })).body;
    const summary = outcome.threads.find((t: Body) => t.threadId === threadId);
    check(summary?.status === "completed" && /OK/u.test(summary.headline), `project_get shows the reply: ${JSON.stringify(summary)}`);
    ok(`project_get: stale=${outcome.stale} thread status=${summary.status} headline="${summary.headline}"`);
    const tail = (await callTool(client, "thread_tail", { machineId: "lab-b", threadId, n: 5 })).body;
    const reply = tail.items.find((i: Body) => i.kind === "message" && i.role === "assistant");
    check(reply && /OK/u.test(reply.text), `thread_tail has the assistant reply: ${JSON.stringify(tail.items)}`);
    ok(`thread_tail: ${tail.items.length} items, newest assistant text "${reply.text}"`);

    // 5. lab-a goes offline when its node stops: stale cached reads, refused writes.
    await stopProcess("node-lab-a");
    const offline = await until("machine.offline for lab-a", 120_000, async () => {
      const page = (await callTool(client, "events_wait", { cursor, machineId: "lab-a", types: ["machine.offline"], timeoutSec: 50 })).body;
      cursor = page.cursor;
      return page.events[0];
    });
    ok(`events_wait: machine.offline seq=${offline.seq} "${offline.summary}"`);
    const staleRead = (await callTool(client, "project_get", { machineId: "lab-a", projectId: projectA.projectId })).body;
    check(staleRead.stale === true, `lab-a project_get is stale: ${JSON.stringify(staleRead)}`);
    ok(`project_get lab-a: stale=${staleRead.stale} asOf=${staleRead.asOf}`);
    const refused = await callTool(client, "thread_launch", {
      machineId: "lab-a",
      projectId: projectA.projectId,
      prompt: "Reply OK.",
      model: MODEL,
      effort: "low",
      clientRequestId: randomUUID(),
    });
    check(refused.isError && refused.body.code === "machine_offline", `launch on lab-a refused: ${JSON.stringify(refused.body)}`);
    ok(`thread_launch lab-a refused: ${refused.body.code} (fix: ${refused.body.fix})`);
    await client.close();
    log("PASS");
  } finally {
    for (const { name } of started.toReversed()) await stopProcess(name);
    for (const id of labStarted) ok(lab("down", id).trim());
  }
}

main().catch((error: unknown) => {
  log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  log(`logs: ${path.join(RUN, "logs")}`);
  process.exitCode = 1;
});
