// `npm run lab -- [scenario…]` (in tests/lab): the M1-M9 "done when" scenarios, end to end, against the disposable lab
// (never in CI); M7 and M9 also use the GitHub testbed unlaboredlabs/fleetd-testbed. One hub and two nodes (lab-a,
// lab-b), each node running the real `claude` itself under its own HOME, driven only through a real MCP client.
// Each scenario is a file exporting one function over the shared `Lab`; name some to run only those (setup always
// runs). Costs a handful of tiny claude-haiku-5-5 turns. Every process this starts is stopped by its spawn PID.
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { degradedMachine } from "./degradedMachine.ts";
import { FAILURE_SCENARIOS } from "./failure/index.ts";
import {
  type Body,
  callToolWith,
  check,
  cleanupMachineHomes,
  cli,
  HUB_PORT,
  HUB_URL,
  joinNode,
  LAB,
  type Lab,
  launchTiny,
  log,
  MACHINES,
  nodeEnv,
  nodeHome,
  type NodeOptions,
  ok,
  pidOf,
  QUEUE_TTL_SEC,
  RUN,
  seedRepo,
  setCmdRoots,
  startCli,
  stopAll,
  stopCli,
  takeLabLock,
  until,
  waitEventWith,
  writeFleetdWrapper,
} from "./harness.ts";
import { m1Fleet } from "./m1Fleet.ts";
import { m3Loop } from "./m3Loop.ts";
import { m5Tasks } from "./m5Tasks.ts";
import { m6Verify } from "./m6Verify.ts";
import { m7Train } from "./m7Train.ts";
import { m8Desktop } from "./m8Desktop.ts";
import { m9Playbooks } from "./m9Playbooks.ts";
import { offlineQueue } from "./offlineQueue.ts";
import { scenarioPush } from "./scenarioPush.ts";
import { wakeOnTime } from "./wakeOnTime.ts";
import { missedCompletion, stallNudgeFail } from "./watchdogScenarios.ts";

/** In run order. Later ones may stop or restart nodes, so they come after the ones that need both machines up. */
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
  // The native runner's failure scenarios (tests/lab/failure): they restart lab-b and add a machine, so they go last.
  ...FAILURE_SCENARIOS,
];

const hubHome = path.join(RUN, "hub");
// The intake router runs `claude -p` on the hub. Like an installed hub, it finds Claude through the user's own login,
// not variables passed in.
const startHubProcess = async (env: Readonly<Record<string, string>> = {}) => {
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

  let client: Client | undefined;
  try {
    // A fresh run dir: a new hub and new machine homes (node stores, Claude config dirs). The test repos persist.
    fs.rmSync(RUN, { recursive: true, force: true });
    writeFleetdWrapper();
    for (const m of MACHINES) seedRepo(m.repo, m.id);
    await startHubProcess();
    ok(`hub up on ${HUB_URL} (queue TTL ${QUEUE_TTL_SEC} s)`);

    const key = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", hubHome, "--name", "lab", "--role", "operate", "--machines", "*"))?.[0];
    if (key === undefined) throw new Error("hub key create printed no key");
    for (const m of MACHINES) joinNode(HUB_URL, hubHome, m.id);

    client = await connectClient(key);
    const callTool = callToolWith(() => client!);
    ok(`MCP client connected; ${(await client.listTools()).tools.length} tools`);
    const cursor = async () => (await callTool("fleetd_status")).body.cursor as number;
    const waitEvent = waitEventWith(callTool);

    const online = (machineId: string) =>
      until(`${machineId} online`, 120_000, async () => {
        const s = (await callTool("fleetd_status")).body;
        if (s.machines.some((m: Body) => m.machineId === machineId && m.status === "online")) return true;
        await callTool("events_wait", { cursor: s.cursor, timeoutSec: 5 });
        return undefined;
      });
    const waitLive = async (machineId: string) => {
      await until(`${machineId} online with a live session link`, 120_000, async () => {
        const s = (await callTool("fleetd_status")).body;
        const project = s.projects.find((p: Body) => p.machineId === machineId);
        const isOnline = s.machines.some((m: Body) => m.machineId === machineId && m.status === "online");
        if (isOnline && project && (await callTool("project_get", { machineId, projectId: project.projectId })).body.stale === false) return true;
        await callTool("events_wait", { cursor: s.cursor, timeoutSec: 5 });
        return undefined;
      });
    };
    const addProject = async (machineId: string, dir: string, title: string) => {
      const added = await callTool("project_add", { machineId, path: dir, title });
      check(!added.isError && typeof added.body.projectId === "string", `project_add ${machineId} ${dir}: ${JSON.stringify(added.body)}`);
      const projectId = added.body.projectId as string;
      await until(`${machineId} lists project ${projectId}`, 60_000, async () => {
        const listed = ((await callTool("projects_list", { machineId })).body.projects as Array<Body>).some((p) => p.projectId === projectId);
        if (!listed) await callTool("events_wait", { cursor: await cursor(), timeoutSec: 3 });
        return listed ? true : undefined;
      });
      return projectId;
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
      addProject,
      stopNode: (machineId: string, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => stopCli(`node-${machineId}`, signal),
      startNode: (machineId: string, opts: NodeOptions = {}) =>
        void startCli(`node-${machineId}`, ["node", "run", "--home", nodeHome(machineId)], {}, nodeEnv(machineId, opts)),
      nodePid: (machineId: string) => pidOf(`node-${machineId}`),
      joinNode: (machineId: string, opts: NodeOptions & { readonly login?: boolean } = {}) => void joinNode(HUB_URL, hubHome, machineId, opts),
      machines: MACHINES,
      stopHub: async () => {
        await client?.close().catch(() => undefined);
        await stopCli("hub");
      },
      startHub: async (env = {}) => {
        await client?.close().catch(() => undefined);
        await stopCli("hub");
        await startHubProcess(env);
        client = await connectClient(key);
        // The store still says online from before; wait until running nodes have relinked.
        for (const m of MACHINES) if (pidOf(`node-${m.id}`) !== undefined) await waitLive(m.id);
        ok(`hub (re)started${Object.keys(env).length > 0 ? ` with ${Object.keys(env).join(", ")}` : ""}`);
      },
      idleThread: async (machineId: string) => {
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

    // Each machine's test repo is its project, registered the way a user would. The node runs `cmd` checks only under
    // its roots, so once enrolled it gets the lab dir (repos, testbed) as its root and restarts. The hub may still show
    // it online from before, so project_add is retried until the relinked node takes it.
    for (const m of MACHINES) {
      await online(m.id);
      await stopCli(`node-${m.id}`);
      setCmdRoots(m.id, [LAB]);
      base.startNode(m.id);
      const projectId = await until(`project_add on ${m.id}`, 60_000, async () => {
        const added = await callTool("project_add", { machineId: m.id, path: m.repo, title: path.basename(m.repo) });
        if (!added.isError) return added.body.projectId as string;
        await callTool("events_wait", { cursor: await cursor(), timeoutSec: 2 });
        return undefined;
      });
      ok(`project_add ${m.id} ${m.repo} -> ${projectId}`);
    }
    for (const m of MACHINES) await waitLive(m.id);
    const s = (await callTool("fleetd_status")).body;
    ok(`fleetd_status: ${s.machines.map((m: Body) => `${m.machineId}=${m.status}`).join(", ")}; ${s.projects.length} projects`);

    for (const scenario of scenarios) {
      log(`--- ${scenario.name}`);
      await scenario.run({ ...base, dir: path.join(RUN, scenario.name) });
      ok(`scenario ${scenario.name} passed`);
    }
    log(`PASS ${scenarios.map((s) => s.name).join(" ")}`);
  } finally {
    await client?.close().catch(() => undefined);
    await stopAll();
    cleanupMachineHomes();
  }
}

main().catch((error: unknown) => {
  log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  // A bare "fetch failed" says nothing about which call; the stack and cause do.
  if (error instanceof Error) log(`${error.stack?.split("\n").slice(1, 6).join("\n") ?? ""}${error.cause === undefined ? "" : `\ncause: ${String(error.cause)}`}`);
  log(`logs: ${path.join(RUN, "logs")}`);
  process.exitCode = 1;
});
