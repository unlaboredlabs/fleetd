// M2 lab scenario 4, "degraded machine": lab-b's T3 is killed by its recorded PID; its node reports it down
// within 20 s (hub emits machine.degraded), restarts it with --t3-restart-cmd, and the machine comes back online.
// No claude turns. `degradedMachine` is the scenario for the shared `pnpm test:lab` run, which must join lab-b's
// node with `--t3-restart-cmd "<labRestartCmd('lab-b')>"`. Run this file directly to try it alone:
//   node apps/hub/src/lab/degradedMachine.ts
// Alone, it refuses to start if lab-b is already running (someone else's run would lose its T3).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { T3_SRC } from "./harness.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const LAB = process.env.FLEETD_LAB ?? path.join(os.homedir(), "src/fleetd-lab");

type Body = Record<string, any>;

export interface LabContext {
  readonly callTool: (name: string, args?: Record<string, unknown>) => Promise<{ readonly isError: boolean; readonly body: Body }>;
  readonly log: (line: string) => void;
}

/** The node's restart command for a lab instance: the lab's own `up`, which starts it by PID file and waits for health. */
export const labRestartCmd = (instance: string) => `${process.execPath} ${path.join(REPO, "lab/lab.mjs")} up ${instance}`;

/** lab-b's T3 PID from the lab's PID file, only if that PID is still lab-b's server (guards against PID reuse). */
const labServerPid = (instance: "lab-b") => {
  const pid = Number(fs.readFileSync(path.join(LAB, "pids", `${instance}.pid`), "utf8").trim());
  const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  if (!cmdline.includes(path.join(LAB, "home-b")) || !cmdline.some((a) => a.endsWith("apps/server/src/bin.ts"))) {
    throw new Error(`pid ${pid} is not ${instance}'s T3 server`);
  }
  return pid;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<A>(what: string, ms: number, probe: () => Promise<A | undefined>): Promise<A> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await sleep(250);
  }
  throw new Error(`timed out after ${ms / 1000}s: ${what}`);
}

const check = (cond: unknown, what: string): void => {
  if (!cond) throw new Error(`check failed: ${what}`);
};

/** Expects lab-b online with its node joined using `labRestartCmd("lab-b")`. Leaves lab-b's T3 running. */
export async function degradedMachine(ctx: LabContext) {
  const { callTool, log } = ctx;
  const machineB = async () => (await callTool("fleetd_status")).body.machines.find((m: Body) => m.machineId === "lab-b");
  const start = await callTool("fleetd_status");
  check(start.body.machines.find((m: Body) => m.machineId === "lab-b")?.status === "online", "lab-b is online before the kill");
  let cursor = start.body.cursor as number;

  const pid = labServerPid("lab-b");
  const killedAt = Date.now();
  process.kill(pid, "SIGKILL");
  log(`ok  killed lab-b T3 pid=${pid} (SIGKILL, by its recorded PID)`);

  const waitEvent = (type: string, ms: number) =>
    until(type, ms, async () => {
      const page = (await callTool("events_wait", { cursor, machineId: "lab-b", types: [type], timeoutSec: 5 })).body;
      cursor = page.cursor;
      return page.events[0] as Body | undefined;
    });

  const degraded = await waitEvent("machine.degraded", 20_000);
  const degradedAfter = (Date.now() - killedAt) / 1000;
  check(degradedAfter <= 20, `machine.degraded within 20 s (took ${degradedAfter} s)`);
  const status = await machineB();
  log(`ok  machine.degraded seq=${degraded.seq} ${degradedAfter.toFixed(1)} s after the kill: "${degraded.summary}"`);
  log(`ok  fleetd_status lab-b: status=${status.status} degradedReason="${status.degradedReason ?? ""}"`);

  const online = await waitEvent("machine.online", 180_000);
  const newPid = labServerPid("lab-b");
  check(newPid !== pid, `lab-b T3 has a new PID (${newPid})`);
  log(`ok  machine.online seq=${online.seq} ${((Date.now() - killedAt) / 1000).toFixed(1)} s after the kill; node restarted T3 as pid=${newPid}`);

  // Online again with a live executor: the re-minted session works against the new T3.
  const projectId = (await callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === "lab-b")?.projectId;
  check(projectId, "lab-b has a cached project");
  const fresh = await until("project_get lab-b fresh", 60_000, async () => {
    const outcome = (await callTool("project_get", { machineId: "lab-b", projectId })).body;
    return outcome.stale === false ? outcome : undefined;
  });
  const after = await machineB();
  check(after.status === "online" && after.degradedReason === undefined, `lab-b online without a reason: ${JSON.stringify(after)}`);
  log(`ok  project_get lab-b: stale=${fresh.stale} asOf=${fresh.asOf}; machine status=${after.status}`);
}

// Standalone run: lab-b T3, a hub and lab-b's node, all stopped by the PIDs captured here.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const HUB_PORT = Number(process.env.FLEETD_LAB_DEGRADED_HUB_PORT ?? 4796);
  const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
  const RUN = path.join(LAB, "e2e-degraded");
  const CLI = path.join(REPO, "apps/cli/src/bin.ts");
  if (path.resolve(LAB).startsWith(path.join(os.homedir(), ".t3"))) throw new Error("refusing: lab dir is inside ~/.t3");
  const scrubbedEnv = () =>
    Object.fromEntries(["HOME", "PATH", "USER", "LANG"].flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));
  const t0 = Date.now();
  const log = (line: string) => process.stdout.write(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}\n`);
  const started: Array<{ name: string; child: ChildProcess }> = [];
  const lab = (command: string) =>
    execFileSync(process.execPath, [path.join(REPO, "lab/lab.mjs"), command, "lab-b"], { env: scrubbedEnv(), encoding: "utf8" }).trim();
  const cli = (...args: Array<string>) =>
    execFileSync(process.execPath, [CLI, ...args], { env: scrubbedEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const startProcess = (name: string, args: Array<string>) => {
    fs.mkdirSync(path.join(RUN, "logs"), { recursive: true });
    const out = fs.openSync(path.join(RUN, "logs", `${name}.log`), "w");
    const child = spawn(process.execPath, [CLI, ...args], { env: scrubbedEnv(), stdio: ["ignore", out, out] });
    started.push({ name, child });
    log(`started ${name} pid=${child.pid}`);
  };
  const stopAll = async () => {
    for (const { name, child } of started.toReversed()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
      log(`stopped ${name} pid=${child.pid}`);
    }
  };

  const main = async () => {
    if (/running/u.test(lab("status"))) throw new Error("lab-b is already running; stop it (node lab/lab.mjs down lab-b) or use the shared run");
    log(`ok  ${lab("up")}`);
    try {
      fs.rmSync(RUN, { recursive: true, force: true });
      const hubHome = path.join(RUN, "hub");
      startProcess("hub", ["hub", "start", "--home", hubHome, "--listen", `127.0.0.1:${HUB_PORT}`]);
      await until("hub /healthz", 30_000, async () => ((await fetch(`${HUB_URL}/healthz`).catch(() => undefined))?.ok ? true : undefined));
      const key = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", hubHome, "--name", "lab", "--role", "operate", "--machines", "*"))?.[0];
      const token = /^\S{16,}$/mu.exec(cli("hub", "token", "create", "--home", hubHome, "--machine", "lab-b"))?.[0];
      check(key && token, "hub key and enrollment token");
      startProcess("node-lab-b", [
        "node", "join", "--hub", HUB_URL, "--token", token!, "--machine", "lab-b",
        "--t3-home", path.join(LAB, "home-b"), "--t3-url", "http://127.0.0.1:4712",
        "--t3-cmd", `${process.execPath} ${path.join(T3_SRC, "apps/server/src/bin.ts")}`,
        "--t3-restart-cmd", labRestartCmd("lab-b"), "--home", path.join(RUN, "node-lab-b"),
      ]);
      const client = new Client({ name: "fleetd-test-lab-degraded", version: "0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${HUB_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }) as Transport,
      );
      const callTool: LabContext["callTool"] = async (name, args = {}) => {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 70_000 });
        return { isError: result.isError === true, body: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Body };
      };
      await until("lab-b online with a project", 120_000, async () => {
        const s = (await callTool("fleetd_status")).body;
        return s.machines.some((m: Body) => m.machineId === "lab-b" && m.status === "online") && s.projects.some((p: Body) => p.machineId === "lab-b")
          ? true
          : undefined;
      });
      log("ok  lab-b online with its project cached");
      await degradedMachine({ callTool, log });
      // The node re-mints on recovery and the hub reattaches with it (only the logs show the second session).
      const count = (file: string, line: string) => fs.readFileSync(path.join(RUN, "logs", file), "utf8").split(line).length - 1;
      await until("a re-minted session attached", 30_000, async () =>
        count("node-lab-b.log", "t3 session minted") >= 2 && count("hub.log", "t3 session attached") >= 2 ? true : undefined,
      );
      log("ok  node re-minted its T3 session after the restart and the hub attached it");
      await client.close();
      log("PASS");
    } finally {
      await stopAll();
      log(`ok  ${lab("down")}`);
    }
  };
  main().catch((error: unknown) => {
    log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    log(`logs: ${path.join(RUN, "logs")}`);
    process.exitCode = 1;
  });
}
