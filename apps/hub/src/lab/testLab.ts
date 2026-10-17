// `pnpm test:lab [scenario…]`: the M1-M9 "done when" scenarios, end to end, against the disposable lab
// (never in CI); M7 and M9 also use the GitHub testbed unlaboredlabs/fleetd-testbed. Two stock T3 instances (lab/lab.mjs), one hub and two nodes, driven only through a real MCP client.
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
  fleetdCommand,
  HUB_PORT,
  HUB_URL,
  isRunning,
  LAB,
  type Lab,
  lab,
  type LabMachine,
  launchTiny,
  log,
  MACHINES,
  mintT3Bearer,
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
import { m3Loop } from "./m3Loop.ts";
import { m5Tasks } from "./m5Tasks.ts";
import { m6Verify } from "./m6Verify.ts";
import { m7Train, removeTestbedProject } from "./m7Train.ts";
import { m8Desktop } from "./m8Desktop.ts";
import { m9Playbooks } from "./m9Playbooks.ts";
import { offlineQueue } from "./offlineQueue.ts";
import { scenarioPush } from "./scenarioPush.ts";
import { wakeOnTime } from "./wakeOnTime.ts";
import { missedCompletion, stallNudgeFail } from "./watchdogScenarios.ts";

/** In run order. Later ones may stop nodes or kill T3, so they come after the ones that need both machines up. */
const SCENARIOS: ReadonlyArray<{ readonly name: string; readonly run: (lab: Lab) => Promise<void> }> = [
  { name: "m1", run: m1Fleet },
  { name: "wake", run: wakeOnTime },
  { name: "push", run: scenarioPush },
  { name: "stall", run: (lab) => stallNudgeFail(lab) },
  { name: "missed", run: (lab) => missedCompletion(lab) },
  { name: "degraded", run: degradedMachine },
  { name: "queue", run: offlineQueue },
  // Last: its lead thread on lab-a would otherwise be picked as an idle thread by the scenarios above.
  { name: "m3", run: m3Loop },
  // After m3: it reuses m3's lead and workstream when they exist.
  { name: "m5", run: m5Tasks },
  // After m5: it reuses the lead when there is one.
  { name: "m6", run: m6Verify },
  // It adds the testbed as a second project on lab-a for its run, and removes it.
  { name: "m7", run: m7Train },
  // It reuses the lead when there is one, and waits for the wake it causes to end.
  { name: "m8", run: m8Desktop },
  // After m7, which leaves no testbed project: its router must choose among the lab projects only.
  { name: "m9", run: m9Playbooks },
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
  fs.mkdirSync(LAB, { recursive: true });
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

/**
 * What a lead's shell needs, at the stable paths lab/lab.mjs gives each T3: `fleetd` on PATH (the fleetd under test)
 * and FLEETD_NODE_SOCK pointing at this run's node socket.
 */
const linkLeadShell = () => {
  fs.mkdirSync(path.join(LAB, "bin"), { recursive: true });
  const [bin, prefix] = fleetdCommand([]);
  const exec = [bin, ...prefix].map((a) => `'${a}'`).join(" ");
  fs.writeFileSync(path.join(LAB, "bin", "fleetd"), `#!/bin/sh\nexec ${exec} "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(LAB, "sock"), { recursive: true });
  for (const m of MACHINES) {
    const link = path.join(LAB, "sock", `${m.id}.sock`);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(nodeHome(m.id), "node.sock"), link);
  }
};

// The intake router runs `claude -p` on the hub, so the hub gets the same login variables lab/lab.mjs gives T3.
const startHubProcess = async (env: Readonly<Record<string, string>> = {}) => {
  // Like an installed hub, it finds Claude through the user's own login, not variables passed in.
  startCli("hub", ["hub", "start", "--home", hubHome, "--listen", `127.0.0.1:${HUB_PORT}`, "--queue-ttl", String(QUEUE_TTL_SEC)], env);
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
    // A testbed project left by an interrupted m7 would be taken for lab-a's project by the other scenarios.
    await removeTestbedProject({ machines: MACHINES, mintT3Bearer });
    fs.rmSync(RUN, { recursive: true, force: true });
    linkLeadShell();
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
      machines: MACHINES,
      mintT3Bearer,
      stopHub: async () => {
        await client?.close().catch(() => undefined);
        await stopCli("hub");
      },
      startHub: async (env = {}) => {
        await client?.close().catch(() => undefined);
        await stopCli("hub");
        await startHubProcess(env);
        client = await connectClient(key);
        // The store still says online from before; wait until running nodes have relinked and T3 is attached.
        for (const m of MACHINES) if (isRunning(`node-${m.id}`)) await waitLive(m.id);
        ok(`hub (re)started${Object.keys(env).length > 0 ? ` with ${Object.keys(env).join(", ")}` : ""}`);
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
  // A bare "fetch failed" says nothing about which call; the stack and cause do.
  if (error instanceof Error) log(`${error.stack?.split("\n").slice(1, 6).join("\n") ?? ""}${error.cause === undefined ? "" : `\ncause: ${String(error.cause)}`}`);
  log(`logs: ${path.join(RUN, "logs")}`);
  process.exitCode = 1;
});
