// Lab check: an intent without a project is routed by a hub installed the way users get it (`fleetd init`'s systemd
// user unit, so only HOME, PATH and LANG in its environment), proving the router reaches Claude through the user's own
// `claude` login. Lab only: its own hub home, port and unit suffix; lab T3s on 4711/4712 (FLEETD_LAB_SLOT shifts both). One haiku router run.
//
//   node tests/lab/hubUnitRouter.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Body, callToolWith, check, cli, lab, LAB, MACHINES, ok, slotPort, SLOT, startCli, stopAll, T3_SRC, until, waitEventWith } from "./harness.ts";

const PORT = slotPort(4784);
const URL_ = `http://127.0.0.1:${PORT}`;
const RUN = path.join(LAB, `hub-unit-${PORT}`);
const HOME = path.join(RUN, "hub");
const SUFFIX = SLOT === 0 ? "-labroute" : `-labroute${SLOT}`;
const UNIT = `fleetd-hub${SUFFIX}.service`;

const main = async () => {
  if (fs.existsSync(path.join(LAB, "test-lab.lock"))) throw new Error("another test:lab run holds the lab lock");
  const labStarted: Array<string> = [];
  for (const m of MACHINES) if (!/already running/u.test(lab("up", m.id))) labStarted.push(m.id);
  let client: Client | undefined;
  try {
    fs.rmSync(RUN, { recursive: true, force: true });
    cli("init", "--home", HOME, "--listen", `127.0.0.1:${PORT}`, "--url", URL_, "--unit-suffix", SUFFIX.slice(1));
    const unitEnv = execFileSync("systemctl", ["--user", "show", UNIT, "-p", "Environment", "--value"], { encoding: "utf8" });
    check(!/ANTHROPIC|CLAUDE/u.test(unitEnv), `the installed unit carries no Claude login variables (${unitEnv.trim()})`);
    ok(`hub installed as ${UNIT}; its environment: ${unitEnv.trim().replace(/PATH=\S+/u, "PATH=…")}`);
    await until("hub /healthz", 30_000, async () => ((await fetch(`${URL_}/healthz`).catch(() => undefined))?.ok ? true : undefined));

    const key = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", HOME, "--name", "lab", "--role", "operate", "--machines", "*"))?.[0];
    check(key !== undefined, "an agent key");
    for (const m of MACHINES) {
      const token = /^\S{16,}$/mu.exec(cli("hub", "token", "create", "--home", HOME, "--machine", m.id))?.[0];
      check(token !== undefined, `an enrollment token for ${m.id}`);
      startCli(`node-${m.id}`, [
        "node", "join", "--hub", URL_, "--token", token!, "--machine", m.id, "--t3-home", m.t3Home, "--t3-url", m.t3Url,
        "--t3-cmd", `${process.execPath} ${path.join(T3_SRC, "apps/server/src/bin.ts")}`, "--home", path.join(RUN, `node-${m.id}`),
      ]);
    }
    client = new Client({ name: "lab-hub-unit", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${URL_}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }) as Transport);
    const callTool = callToolWith(() => client!);
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
    ok("PASS hub-unit router");
  } finally {
    await client?.close().catch(() => {});
    await stopAll();
    try {
      cli("uninstall", "--home", HOME, "--purge");
    } catch (error) {
      process.stdout.write(`uninstall failed: ${String(error)}\n`);
    }
    for (const id of labStarted) lab("down", id);
  }
};

main().catch((error: unknown) => {
  process.stdout.write(`FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
