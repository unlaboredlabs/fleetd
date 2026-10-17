// `pnpm test:lab [scenario…]`: the M1 and M2 "done when" scenarios, end to end, against the disposable lab (never
// in CI). Two stock T3 instances (lab/lab.mjs), one hub and two nodes, driven only through a real MCP client.
// Each scenario is a file exporting one function over the shared `Lab`; name some to run only those (setup always
// runs). Costs a handful of tiny claude-haiku-5-5 turns. Every process this starts is stopped by its spawn PID.
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { degradedMachine, labRestartCmd } from "./degradedMachine.ts";
import {
  type Body,
  callToolWith,
  check,
  cli,
  HUB_PORT,
  HUB_URL,
  LAB,
  type Lab,
  lab,
  type LabMachine,
  launchTiny,
  log,
  MACHINES,
  ok,
  QUEUE_TTL_SEC,
  RUN,
  startCli,
  stopAll,
  stopCli,
  T3_SRC,
  until,
  waitEventWith,
} from "./harness.ts";
import { m1Fleet } from "./m1Fleet.ts";
import { offlineQueue } from "./offlineQueue.ts";
import { wakeOnTime } from "./wakeOnTime.ts";

/** In run order. Later ones may stop nodes or kill T3, so they come after the ones that need both machines up. */
const SCENARIOS: ReadonlyArray<{ readonly name: string; readonly run: (lab: Lab) => Promise<void> }> = [
  { name: "m1", run: m1Fleet },
  { name: "wake", run: wakeOnTime },
  { name: "degraded", run: degradedMachine },
  { name: "queue", run: offlineQueue },
];

/** Extra `node join` flags per machine. */
const NODE_FLAGS: Record<LabMachine, ReadonlyArray<string>> = {
  "lab-a": [],
  "lab-b": ["--t3-restart-cmd", labRestartCmd("lab-b")],
};

const hubHome = path.join(RUN, "hub");
const LOCK = path.join(LAB, "test-lab.lock");

/** One test:lab run at a time: they share the lab's T3 instances, and one run's cleanup stops them. */
const takeLabLock = () => {
  try {
    const holder = Number(fs.readFileSync(LOCK, "utf8").trim());
    if (holder > 0 && fs.existsSync(`/proc/${holder}`)) throw new Error(`another test:lab run (pid ${holder}) holds ${LOCK}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.writeFileSync(LOCK, `${process.pid}\n`);
  process.once("exit", () => fs.rmSync(LOCK, { force: true }));
};
const nodeHome = (id: LabMachine) => path.join(RUN, `node-${id}`);

const startHubProcess = async () => {
  startCli("hub", ["hub", "start", "--home", hubHome, "--listen", `127.0.0.1:${HUB_PORT}`, "--queue-ttl", String(QUEUE_TTL_SEC)]);
  await until("hub /healthz", 30_000, async () => {
    try {
      return (await fetch(`${HUB_URL}/healthz`)).ok ? true : undefined;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
      return undefined;
    }
  });
};

const connectClient = async (key: string) => {
  const client = new Client({ name: "fleetd-test-lab", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${HUB_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }) as Transport,
  );
  return client;
};

async function main() {
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((w) => !SCENARIOS.some((s) => s.name === w));
  if (unknown.length > 0) throw new Error(`unknown scenario ${unknown.join(", ")}; known: ${SCENARIOS.map((s) => s.name).join(", ")}`);
  const scenarios = wanted.length === 0 ? SCENARIOS : SCENARIOS.filter((s) => wanted.includes(s.name));
  takeLabLock();

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

  let client: Client | undefined;
  try {
    fs.rmSync(RUN, { recursive: true, force: true });
    await startHubProcess();
    ok(`hub up on ${HUB_URL} (queue TTL ${QUEUE_TTL_SEC} s)`);

    const key = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", hubHome, "--name", "lab", "--role", "operate", "--machines", "*"))?.[0];
    if (key === undefined) throw new Error("hub key create printed no key");
    for (const m of MACHINES) {
      const token = /^\S{16,}$/mu.exec(cli("hub", "token", "create", "--home", hubHome, "--machine", m.id))?.[0];
      if (token === undefined) throw new Error(`no enrollment token for ${m.id}`);
      startCli(`node-${m.id}`, [
        "node", "join", "--hub", HUB_URL, "--token", token, "--machine", m.id, "--t3-home", m.t3Home, "--t3-url", m.t3Url,
        "--t3-cmd", `${process.execPath} ${path.join(T3_SRC, "apps/server/src/bin.ts")}`, "--home", nodeHome(m.id),
        ...NODE_FLAGS[m.id],
      ]);
    }

    client = await connectClient(key);
    const callTool = callToolWith(() => client!);
    ok(`MCP client connected; ${(await client.listTools()).tools.length} tools`);
    const cursor = async () => (await callTool("fleetd_status")).body.cursor as number;
    const waitEvent = waitEventWith(callTool);

    const waitLive = async (machineId: LabMachine) => {
      await until(`${machineId} online with a live T3 connection`, 120_000, async () => {
        const s = (await callTool("fleetd_status")).body;
        const project = s.projects.find((p: Body) => p.machineId === machineId);
        const online = s.machines.some((m: Body) => m.machineId === machineId && m.status === "online");
        if (online && project && (await callTool("project_get", { machineId, projectId: project.projectId })).body.stale === false) return true;
        await callTool("events_wait", { cursor: s.cursor, timeoutSec: 5 });
        return undefined;
      });
    };

    const base = {
      hubUrl: HUB_URL,
      hubHome,
      key,
      callTool,
      log,
      ok,
      check,
      until,
      startCli,
      stopCli,
      waitEvent,
      waitLive,
      cursor,
      stopNode: (machineId: LabMachine) => stopCli(`node-${machineId}`),
      startNode: (machineId: LabMachine) => void startCli(`node-${machineId}`, ["node", "run", "--home", nodeHome(machineId)]),
      stopHub: async () => {
        await client?.close();
        await stopCli("hub");
      },
      startHub: async () => {
        await startHubProcess();
        client = await connectClient(key);
      },
      idleThread: async (machineId: LabMachine) => {
        const projectId = (await callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === machineId)?.projectId;
        check(projectId, `${machineId} has a project`);
        const outcome = (await callTool("project_get", { machineId, projectId })).body;
        const idle = outcome.threads.find((t: Body) => t.status === "completed");
        if (idle !== undefined) return { threadId: idle.threadId as string, projectId: projectId as string };
        const from = await cursor();
        const threadId = await launchTiny({ callTool, check }, machineId, projectId, "fleetd test:lab idle");
        await waitEvent(`idle thread on ${machineId} to finish`, 240_000, {
          cursor: from,
          machineId,
          match: (e) => e.threadId === threadId && e.type === "thread.completed",
        });
        return { threadId, projectId: projectId as string };
      },
    } satisfies Omit<Lab, "dir">;

    for (const m of MACHINES) await waitLive(m.id);
    const s = (await callTool("fleetd_status")).body;
    ok(`fleetd_status: ${s.machines.map((m: Body) => `${m.machineId}=${m.status}`).join(", ")}; ${s.projects.length} projects`);

    for (const scenario of scenarios) {
      log(`--- ${scenario.name}`);
      // It SIGKILLs lab-b's T3, which must not be someone else's.
      if (scenario.name === "degraded" && !labStarted.includes("lab-b")) {
        throw new Error("scenario degraded needs a lab-b T3 this run started; stop lab-b (node lab/lab.mjs down lab-b) and rerun");
      }
      await scenario.run({ ...base, dir: path.join(RUN, scenario.name) });
      ok(`scenario ${scenario.name} passed`);
    }
    log(`PASS ${scenarios.map((s) => s.name).join(" ")}`);
  } finally {
    await client?.close().catch(() => undefined);
    await stopAll();
    for (const id of labStarted) ok(lab("down", id).trim());
  }
}

main().catch((error: unknown) => {
  log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  log(`logs: ${path.join(RUN, "logs")}`);
  process.exitCode = 1;
});
