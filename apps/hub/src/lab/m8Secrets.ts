// `node apps/hub/src/lab/m8Secrets.ts` (with FLEETD_BIN set, or after `pnpm --filter fleetd build`): one sealed secret
// and one approved command that uses it, through a real `fleetd hub` and a real `fleetd node` over their real
// interfaces. No T3 and no claude turns: the node links as degraded, and the project the asks belong to is seeded
// straight into the hub's SQLite before it starts. The value is sealed with libsodium as the desktop app does and
// submitted with a --human key over MCP; the approved command gets it as an env var from the node's own sink, and its
// output comes back with the value scrubbed. Then the hub's home, its log, every event and the node's home and log are
// searched for the value and its ciphertext. The secret-env path is covered nowhere else (m8 runs a command without
// one). Never used in CI.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import sodium from "libsodium-wrappers";
import { type Body, callToolWith, check as must, cli, fleetdCommand, LAB, log, ok, RUN, scrubbedEnv, slotPort, startCli, stopAll, until, waitEventWith } from "./harness.ts";

const PORT = Number(process.env.FLEETD_LAB_M8_PORT ?? slotPort(4783));
const URL_ = `http://127.0.0.1:${PORT}`;
const DIR = path.join(LAB, `m8a-secrets-${PORT}`);
const HUB_HOME = path.join(DIR, "hub");
const NODE_HOME = path.join(DIR, "node");
const MACHINE = "lab-m8a";
const PROJECT = "m8a";
const WORKSPACE = path.join(DIR, "workspace");
// A fresh value per run, so a hit can only come from this run.
const VALUE = `lab-fake-secret-${createHash("sha256").update(String(process.hrtime.bigint())).digest("hex").slice(0, 24)}`;

const filesUnder = (dir: string): Array<[string, string]> =>
  !fs.existsSync(dir)
    ? []
    : fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return filesUnder(full);
        return entry.isFile() ? [[full, fs.readFileSync(full).toString("latin1")]] : [];
      });

/** Each check is logged as it passes, so a run reads as the list of what it proved. */
const check = (cond: unknown, what: string) => {
  must(cond, what);
  ok(what);
};

const keyOf = (out: string) => /fld_[a-z2-7]{20,}/u.exec(out)?.[0];

/** The project row the hub would have cached from T3, which this lab has none of. */
const seedProject = () => {
  const db = new DatabaseSync(path.join(HUB_HOME, "hub.sqlite"));
  try {
    const lastActivityAt = new Date().toISOString();
    const row = { machineId: MACHINE, projectId: PROJECT, title: PROJECT, workspaceRoot: WORKSPACE, threads: { running: 0, waiting: 0, idle: 0, failed: 0 }, lastActivityAt };
    db.prepare("INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES (?, ?, ?, ?, ?)").run(
      MACHINE,
      PROJECT,
      `${row.title}\n${row.workspaceRoot}`,
      lastActivityAt,
      JSON.stringify(row),
    );
  } finally {
    db.close();
  }
};

/** A lead-side `fleetd` call from the project's workspace, through the node's socket. */
const lead = (...args: Array<string>) => {
  const out = spawnSync(...fleetdCommand(args), {
    cwd: WORKSPACE,
    encoding: "utf8",
    env: { ...scrubbedEnv(), PWD: WORKSPACE, FLEETD_NODE_SOCK: path.join(NODE_HOME, "node.sock") },
  });
  must(out.status === 0, `fleetd ${args.slice(0, 3).join(" ")}: exit ${out.status} ${out.stdout}${out.stderr}`);
  return out.stdout;
};

const mcp = async (key: string) => {
  const client = new Client({ name: "fleetd-m8a-lab", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${URL_}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }) as Transport);
  return { client, callTool: callToolWith(() => client) };
};

async function main() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  // Keys and the enrollment token first: that creates and migrates the hub's db, which the project seed writes into.
  const humanKey = keyOf(cli("hub", "key", "create", "--home", HUB_HOME, "--human", "--name", "lab-desk"));
  const agentKey = keyOf(cli("hub", "key", "create", "--home", HUB_HOME, "--name", "lab-agent", "--role", "operate", "--machines", "*"));
  check(humanKey && agentKey, "hub key create printed a human and an agent key");
  const token = cli("hub", "token", "create", "--home", HUB_HOME, "--machine", MACHINE).trim().split("\n").at(-1)!.trim();
  seedProject();
  ok(`hub home ${HUB_HOME}: two keys, an enrollment token for ${MACHINE}, project ${PROJECT} at ${WORKSPACE}`);

  startCli("hub-m8a", ["hub", "start", "--home", HUB_HOME, "--listen", `127.0.0.1:${PORT}`]);
  await until("hub /healthz", 30_000, async () => {
    try {
      return (await fetch(`${URL_}/healthz`)).ok ? true : undefined;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
      return undefined;
    }
  });
  startCli("node-m8a", [
    "node", "join",
    "--hub", URL_,
    "--token", token,
    "--machine", MACHINE,
    "--t3-home", path.join(DIR, "t3-home"),
    // Nothing listens here: the node links as degraded, which secrets and approved commands do not mind.
    "--t3-url", `http://127.0.0.1:${PORT + 1}`,
    "--home", NODE_HOME,
  ]);

  const human = await mcp(humanKey!);
  const agent = await mcp(agentKey!);
  try {
    const { callTool } = human;
    const machine = await until(`${MACHINE} links with a box key`, 60_000, async () => {
      const m = ((await callTool("fleetd_status")).body.machines as Array<Body>).find((x) => x.machineId === MACHINE);
      if (typeof m?.boxPubKey === "string") return m;
      await new Promise((r) => setTimeout(r, 500));
      return undefined;
    });
    const keyFile = path.join(NODE_HOME, "node-box-key.pem");
    check((fs.statSync(keyFile).mode & 0o777) === 0o600, `${MACHINE} linked (${machine.status}) with boxPubKey ${machine.boxPubKey}, key file 0600`);

    // 1. fleetd ask --kind secret, refused to an agent key, then sealed and submitted with the human key.
    const sinkPath = path.join(WORKSPACE, ".env");
    fs.writeFileSync(sinkPath, "OTHER=1\nSTRIPE_TEST_KEY=old\n");
    const askId = /\bA\d+\b/u.exec(lead("ask", "--kind", "secret", "--key", "stripe.test_key", "--sink", `env:${MACHINE}:${sinkPath}`, "--text", "Need the Stripe test key"))?.[0];
    check(askId, "fleetd ask --kind secret filed an ask");
    await sodium.ready;
    const sealed = sodium.to_base64(
      sodium.crypto_box_seal(sodium.from_string(VALUE), sodium.from_base64(machine.boxPubKey, sodium.base64_variants.ORIGINAL)),
      sodium.base64_variants.ORIGINAL,
    );
    const refused = await agent.callTool("secret_submit", { askId, sealed });
    check(refused.isError && refused.body.code === "forbidden", `agent key refused for secret_submit: ${refused.body.message}`);
    const fingerprint = createHash("sha256").update(VALUE).digest("hex").slice(0, 8);
    const saved = await callTool("secret_submit", { askId, sealed });
    check(!saved.isError && saved.body.fingerprint === fingerprint, `node returned fingerprint ${JSON.stringify(saved.body)}`);
    check(fs.readFileSync(sinkPath, "utf8") === `OTHER=1\nSTRIPE_TEST_KEY=${VALUE}\n` && (fs.statSync(sinkPath).mode & 0o777) === 0o600, "sink rewritten 0600, existing line replaced");
    const answered = ((await callTool("asks_list", { state: "answered" })).body.asks as Array<Body>).find((a) => a.askId === askId);
    check(answered?.evidence === `fingerprint ${fingerprint}`, `${askId} closed with evidence ${JSON.stringify(answered?.evidence)}`);

    // 2. fleetd gated run with the secret as an env var: refused to an agent's "go", run after the human's.
    const argv = ["sh", "-c", 'echo "deploying with $STRIPE"; echo deployed > deployed.txt'];
    const gatedId = /\bA\d+\b/u.exec(
      lead("gated", "run", "--class", "irreversible", "--argv", JSON.stringify(argv), "--reason", "lab deploy test", "--secret-env", "STRIPE=stripe.test_key", "--timeout", "60"),
    )?.[0];
    check(gatedId, "fleetd gated run filed an approve ask");
    const approve = ((await callTool("asks_list", { state: "open" })).body.asks as Array<Body>).find((a) => a.askId === gatedId);
    check(JSON.stringify(approve?.gated?.argv) === JSON.stringify(argv), `${gatedId} shows the exact argv: ${JSON.stringify(approve?.gated)}`);
    const reply = { raw: `${approve!.number} go`, batchId: approve!.batchId };
    const byAgent = await agent.callTool("inbox_reply", reply);
    check(byAgent.isError && byAgent.body.code === "forbidden", `agent "go" refused: ${byAgent.body.message}`);
    const cursor = (await callTool("fleetd_status")).body.cursor as number;
    check((await callTool("inbox_reply", reply)).body.parsed === true, "the human's go");
    const ran = await waitEventWith(callTool)("gated.ran", 60_000, { cursor, types: ["gated.ran"] });
    check(ran.event.data?.exitCode === 0, `gated.ran: ${JSON.stringify(ran.event.data)}`);
    const done = ((await callTool("asks_list", { state: "answered" })).body.asks as Array<Body>).find((a) => a.askId === gatedId);
    const evidence = String(done?.evidence ?? "");
    check(evidence.startsWith("exit 0") && evidence.includes("deploying with [secret]"), `evidence, value scrubbed: ${JSON.stringify(evidence)}`);
    check(fs.readFileSync(path.join(WORKSPACE, "deployed.txt"), "utf8") === "deployed\n", "the stored command ran in the project workspace");

    // 3. The value and its ciphertext appear nowhere but the sink.
    const events: Array<Body> = [];
    for (let from = 0; ; ) {
      const page = (await callTool("events_wait", { cursor: from, timeoutSec: 0 })).body;
      events.push(...(page.events as Array<Body>));
      if (page.more !== true) break;
      from = page.cursor as number;
    }
    const places: Array<[string, string]> = [
      ...filesUnder(HUB_HOME),
      ...filesUnder(NODE_HOME),
      ...["hub-m8a", "node-m8a"].map((name): [string, string] => [name, fs.readFileSync(path.join(RUN, "logs", `${name}.log`), "utf8")]),
      ["events", JSON.stringify(events)],
    ];
    const hits = places.filter(([, text]) => text.includes(VALUE) || text.includes(sealed)).map(([where]) => where);
    must(hits.length === 0, `the secret or its ciphertext is in ${hits.join(", ")}`);
    ok(`plaintext and ciphertext found in none of ${places.length} places searched (hub home, node home, hub and node logs, ${events.length} events)`);
  } finally {
    await human.client.close().catch(() => undefined);
    await agent.client.close().catch(() => undefined);
  }
}

main()
  .then(() => log("PASS m8 secrets"))
  .catch((error: unknown) => {
    log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => stopAll());
