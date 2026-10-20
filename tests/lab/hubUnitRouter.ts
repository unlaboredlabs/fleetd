// Lab check: a hub installed the way users get it (`fleetd init`'s systemd user unit, so only HOME, PATH and LANG in its
// environment) reaches Claude through the user's own `claude` login (doctor hub/claude_login), and an order sent to a
// project's chat waits for lead_start when its policy says the lead starts only by hand. Orders name their project in
// the chat, so there is no router run to watch. Lab only: its own hub home, port (FLEETD_LAB_SLOT shifts it) and unit
// suffix, and the two lab machines with their test repos as projects. No claude turns.
//
//   node tests/lab/hubUnitRouter.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Body, callToolWith, check, cleanupMachineHomes, cli, joinNode, LAB, machineHome, MACHINES, nodeEnv, nodeHome, ok, seedRepo, setCmdRoots, slotPort, SLOT, startCli, stopAll, stopCli, until, writeFleetdWrapper } from "./harness.ts";

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
  let human: Client | undefined;
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
      // A node takes projects only under its cmdRoots (its HOME by default, here the lab's machine home): restart it
      // with the lab dir as its root, then add once the relinked node takes it.
      await stopCli(`node-${m.id}`);
      setCmdRoots(m.id, [LAB]);
      startCli(`node-${m.id}`, ["node", "run", "--home", nodeHome(m.id)], {}, nodeEnv(m.id));
      await until(`project_add on ${m.id}`, 60_000, async () => {
        const added = await callTool("project_add", { machineId: m.id, path: m.repo, title: path.basename(m.repo) });
        if (!added.isError) return true;
        await callTool("events_wait", { cursor: (await callTool("fleetd_status")).body.cursor, timeoutSec: 2 });
        return undefined;
      });
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

    // A person's key, as the desktop app pairs one: only people write in a project's chat.
    const humanKey = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", HOME, "--human", "--name", "lab-person"))?.[0];
    check(humanKey !== undefined, "a human key");
    human = new Client({ name: "lab-hub-unit-person", version: "0" });
    await human.connect(new StreamableHTTPClientTransport(new URL(`${URL_}/mcp`), { requestInit: { headers: { authorization: `Bearer ${humanKey}` } } }) as Transport);
    const text = "fix: a README line has a typo";
    const projectRef = { machineId: target.machineId as string, projectId: target.projectId as string };
    const submitted = await callToolWith(() => human!)("chat_send", { projectRef, text, clientRequestId: randomUUID() });
    check(!submitted.isError && submitted.body.message?.author === "human", `chat_send to lab-b/${target.title}: ${JSON.stringify(submitted.body)}`);
    ok(`chat_send "${text}" → lab-b/${target.title} (delivery ${submitted.body.message.delivery})`);
    check(String(submitted.body.leadWaiting ?? "").includes("lead.autoStart: false"), `the order waits for lead_start, as the policy says: ${JSON.stringify(submitted.body)}`);
    const project = (await callTool("project_get", projectRef)).body;
    check(project.lead === undefined, `no lead started: ${JSON.stringify(project.lead)}`);
    ok(`no lead started: ${submitted.body.leadWaiting}`);
    ok("PASS hub-unit router");
  } finally {
    for (const [file, text] of policies) {
      if (text === undefined) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, text);
    }
    await client?.close().catch(() => {});
    await human?.close().catch(() => {});
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
