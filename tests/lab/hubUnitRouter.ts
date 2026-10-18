// Lab check: an intent without a project is routed by a hub installed the way users get it (`fleetd init`'s systemd
// user unit, so only HOME, PATH and LANG in its environment), proving the router reaches Claude through the user's own
// `claude` login. Lab only: its own hub home, port (FLEETD_LAB_SLOT shifts it) and unit suffix, and the two lab machines
// with their test repos as projects. One haiku router run; a policy file keeps the order from starting a lead.
//
//   node tests/lab/hubUnitRouter.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Body, callToolWith, check, cleanupMachineHomes, cli, joinNode, LAB, machineHome, MACHINES, ok, seedRepo, slotPort, SLOT, stopAll, until, waitEventWith, writeFleetdWrapper } from "./harness.ts";

const PORT = slotPort(4784);
const URL_ = `http://127.0.0.1:${PORT}`;
const RUN = path.join(LAB, `hub-unit-${PORT}`);
const HOME = path.join(RUN, "hub");
const SUFFIX = SLOT === 0 ? "-labroute" : `-labroute${SLOT}`;
const UNIT = `fleetd-hub${SUFFIX}.service`;
const POLICY = 'areas:\n  all: ["**"]\nlead:\n  autoStart: false\n';

const main = async () => {
  if (fs.existsSync(path.join(LAB, "test-lab.lock"))) throw new Error("another test:lab run holds the lab lock");
  let client: Client | undefined;
  // Each repo's own policy file, if it had one, put back afterwards.
  const policies = new Map<string, string | undefined>();
  try {
    fs.rmSync(RUN, { recursive: true, force: true });
    // The machines' homes live in the lab's shared run dir, which no run is using (the lock above): start them fresh.
    for (const m of MACHINES) fs.rmSync(machineHome(m.id), { recursive: true, force: true });
    writeFleetdWrapper();
    cli("init", "--home", HOME, "--listen", `127.0.0.1:${PORT}`, "--url", URL_, "--unit-suffix", SUFFIX.slice(1));
    const unitEnv = execFileSync("systemctl", ["--user", "show", UNIT, "-p", "Environment", "--value"], { encoding: "utf8" });
    check(!/ANTHROPIC|CLAUDE/u.test(unitEnv), `the installed unit carries no Claude login variables (${unitEnv.trim()})`);
    ok(`hub installed as ${UNIT}; its environment: ${unitEnv.trim().replace(/PATH=\S+/u, "PATH=…")}`);
    await until("hub /healthz", 30_000, async () => ((await fetch(`${URL_}/healthz`).catch(() => undefined))?.ok ? true : undefined));

    const key = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", HOME, "--name", "lab", "--role", "operate", "--machines", "*"))?.[0];
    check(key !== undefined, "an agent key");
    for (const m of MACHINES) {
      seedRepo(m.repo, m.id);
      const file = path.join(m.repo, ".fleetd/policy.yaml");
      policies.set(file, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, POLICY);
      joinNode(URL_, HOME, m.id);
    }
    client = new Client({ name: "lab-hub-unit", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${URL_}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }) as Transport);
    const callTool = callToolWith(() => client!);
    for (const m of MACHINES) {
      await until(`${m.id} online`, 120_000, async () => {
        const s = (await callTool("fleetd_status")).body;
        if ((s.machines as Array<Body>).some((x) => x.machineId === m.id && x.status === "online")) return true;
        await callTool("events_wait", { cursor: s.cursor, timeoutSec: 3 });
        return undefined;
      });
      const added = await callTool("project_add", { machineId: m.id, path: m.repo, title: path.basename(m.repo) });
      check(!added.isError, `project_add ${m.id}: ${JSON.stringify(added.body)}`);
    }
    const projects = await until("both lab projects listed", 120_000, async () => {
      const s = (await callTool("fleetd_status")).body;
      return s.projects.length >= 2 ? (s.projects as Array<Body>) : undefined;
    });
    const target = projects.find((p) => p.machineId === "lab-b")!;
    ok(`projects: ${projects.map((p) => `${p.machineId}/${p.title}`).join(", ")}`);

    const doctor = (await callTool("doctor_list", { rerun: true })).body.checks.find((c: Body) => c.id === "hub/claude_login");
    check(doctor?.status === "ok", `doctor hub/claude_login ok: ${JSON.stringify(doctor)}`);
    ok(`doctor: ${doctor.message}`);

    const cursor = (await callTool("fleetd_status")).body.cursor as number;
    const text = `fix: in the ${target.title} project on lab-b, a README line has a typo`;
    const submitted = await callTool("intake_submit", { text, clientRequestId: randomUUID() });
    check(!submitted.isError, `intake_submit: ${JSON.stringify(submitted.body)}`);
    const { event } = await waitEventWith(callTool)("intake.routed", 120_000, { cursor, types: ["intake.routed"] });
    const runs = (event.data?.usage as Array<Body> | undefined) ?? [];
    check(runs.length >= 1 && runs.every((r) => r.ok === true), `router runs ok: ${JSON.stringify(runs)}`);
    check(submitted.body.workstreamId !== undefined && event.projectId === target.projectId, `routed to lab-b's project: ${JSON.stringify({ event, body: submitted.body })}`);
    ok(`routed "${text}" → lab-b/${target.title} (${runs.map((r) => `${r.model} ${r.durationMs} ms`).join(", ")}); echo: ${submitted.body.echo?.reason}`);
    check(String(submitted.body.leadWaiting ?? "").includes("lead.autoStart: false"), `the order waits for lead_start, as the policy says: ${JSON.stringify(submitted.body)}`);
    ok(`no lead started: ${submitted.body.leadWaiting}`);
    ok("PASS hub-unit router");
  } finally {
    for (const [file, text] of policies) {
      if (text === undefined) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, text);
    }
    await client?.close().catch(() => {});
    await stopAll();
    try {
      cli("uninstall", "--home", HOME, "--purge");
    } catch (error) {
      process.stdout.write(`uninstall failed: ${String(error)}\n`);
    }
    cleanupMachineHomes();
  }
};

main().catch((error: unknown) => {
  process.stdout.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
