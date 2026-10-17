// M8 "done when" on lab-a, through the desktop app's protocol: a human key from `fleetd hub key create --human` on
// the hub's /app WebSocket, sending the same frames and tool calls the GPUI app sends. A secret ask is sealed client
// side with libsodium's crypto_box_seal (the app's Rust seal is checked against libsodium in its own tests) and lands
// 0600 on the node, its value found nowhere in the hub's files, logs or events; a checklist ticked done fails its
// verify check, reopens, then passes; a gated irreversible command is refused to an agent key and runs after Approve,
// waking the lead with its exit code. The loud items carry the `attention` the app notifies from, and attention_policy
// answers. The asks are filed from the project's shell as a lead would, so they cost no turns; a lead is started only
// if none exists, just before the approval, so a run alone costs two haiku turns (lead start, the approval's wake).
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sodium from "libsodium-wrappers";
import { type Body, cli, fleetdCommand, HUB_PORT, LAB, type Lab, MODEL, RUN, scrubbedEnv } from "./harness.ts";
import { TESTBED } from "./m7Train.ts";

const MACHINE = "lab-a";
const TURN_MS = 240_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];

/** One /app session with `key`: what the desktop app's client does, minus the window. */
const appSession = async (key: string) => {
  const ws = new WebSocket(`ws://127.0.0.1:${HUB_PORT}/app`);
  const waiting = new Map<string, { resolve: (v: Body) => void; reject: (e: Error) => void }>();
  let ready: (() => void) | undefined;
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data)) as Body;
    if (m.t === "ready") ready?.();
    const w = typeof m.id === "string" ? waiting.get(m.id) : undefined;
    if (w === undefined) return;
    waiting.delete(m.id);
    if (m.t === "result") w.resolve(m.output as Body);
    else w.reject(new Error(`${m.code}: ${m.message}`));
  };
  await new Promise<void>((resolve, reject) => {
    ready = resolve;
    ws.onopen = () => ws.send(JSON.stringify({ t: "auth", key }));
    ws.onerror = () => reject(new Error("cannot open /app"));
  });
  let nextId = 0;
  const call = (tool: string, input: Record<string, unknown> = {}) =>
    new Promise<Body>((resolve, reject) => {
      const id = `c${++nextId}`;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ t: "call", id, tool, input }));
    });
  /** The inbox item for `askId`, and the terse reply for it, as the app sends it. */
  const item = async (askId: string) => {
    const open = await call("asks_list", { state: "open" });
    const ask = (open.asks as Array<Body>).find((a) => a.askId === askId);
    return ask === undefined ? undefined : { ask, raw: (word: string) => ({ raw: `${ask.number} ${word}`, batchId: ask.batchId }) };
  };
  return { call, item, close: () => ws.close() };
};

const filesUnder = (dir: string): Array<[string, string]> =>
  !fs.existsSync(dir)
    ? []
    : fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return filesUnder(full);
        return entry.isFile() ? [[full, fs.readFileSync(full).toString("latin1")]] : [];
      });

export async function m8Desktop(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  // The hub keeps m7's deleted testbed project in its list; this scenario uses lab-a's own repo.
  const projectId = (await callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === MACHINE && p.workspaceRoot !== TESTBED)?.projectId as string;
  check(projectId, `${MACHINE} has a project`);
  const ref = { machineId: MACHINE, projectId };
  const root = (await callTool("project_get", ref)).body.project.workspaceRoot as string;
  fs.rmSync(lab.dir, { recursive: true, force: true });
  fs.mkdirSync(lab.dir, { recursive: true });
  const scenarioStart = await lab.cursor();
  // A fresh value per run, so a hit can only come from this run.
  const VALUE = `sk_test_lab_${crypto.randomBytes(12).toString("hex")}`;

  const fleetd = (...args: Array<string>) => {
    const out = spawnSync(...fleetdCommand(args), {
      cwd: root,
      encoding: "utf8",
      env: { ...scrubbedEnv(), PWD: root, FLEETD_NODE_SOCK: path.join(LAB, "sock", `${MACHINE}.sock`) },
    });
    check(out.status === 0, `fleetd ${args.slice(0, 3).join(" ")}: exit ${out.status} ${out.stdout}${out.stderr}`);
    return out.stdout;
  };
  /** Every event after `cursor` that matches, page by page. */
  const allEvents = async (cursor: number, filter: Record<string, unknown> = {}) => {
    const events: Array<Body> = [];
    for (let from = cursor; ; ) {
      const page = (await callTool("events_wait", { cursor: from, timeoutSec: 0, ...filter })).body;
      events.push(...(page.events as Array<Body>));
      if (page.more !== true) return events;
      from = page.cursor as number;
    }
  };
  const askOf = async (askId: string, state: "open" | "answered") =>
    ((await callTool("asks_list", { state })).body.asks as Array<Body>).find((a) => a.askId === askId);

  // The desktop app's key: a person's, so its answers count as the human's.
  const key = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", lab.hubHome, "--human", "--name", "lab-desktop"))?.[0];
  check(key, "hub key create --human printed a key");
  const app = await appSession(key!);
  try {
    const policy = await app.call("attention_policy");
    check(policy.coalesceSec === 1200 && Array.isArray(policy.quiet), `attention_policy: ${JSON.stringify(policy)}`);
    ok(`0. connected on /app with a --human key; attention_policy coalesces ${policy.coalesceSec} s, ${policy.quiet.length} quiet window(s) ahead`);

    // 1. Secret ask, sealed client side to the node's box key.
    const sinkDir = path.join(lab.dir, "secrets");
    fs.mkdirSync(sinkDir, { recursive: true });
    const sinkPath = path.join(sinkDir, ".env");
    fs.writeFileSync(sinkPath, "OTHER=1\n");
    const secretAsk = /\bA\d+\b/u.exec(fleetd("ask", "--kind", "secret", "--key", "stripe.test_key", "--sink", `env:${MACHINE}:${sinkPath}`, "--text", "Need the Stripe test key"))?.[0];
    check(secretAsk, "fleetd ask --kind secret filed an ask");
    const machine = ((await app.call("fleetd_status")).machines as Array<Body>).find((m) => m.machineId === MACHINE);
    check(typeof machine?.boxPubKey === "string", `${MACHINE} has a box key`);
    await sodium.ready;
    const plaintext = sodium.from_string(VALUE);
    const sealed = sodium.to_base64(sodium.crypto_box_seal(plaintext, sodium.from_base64(machine!.boxPubKey, sodium.base64_variants.ORIGINAL)), sodium.base64_variants.ORIGINAL);
    sodium.memzero(plaintext);
    const saved = await app.call("secret_submit", { askId: secretAsk, sealed });
    const fingerprint = crypto.createHash("sha256").update(VALUE).digest("hex").slice(0, 8);
    check(saved.fingerprint === fingerprint, `secret_submit answered fingerprint ${saved.fingerprint}`);
    const sink = fs.readFileSync(sinkPath, "utf8");
    check(sink === `OTHER=1\nSTRIPE_TEST_KEY=${VALUE}\n` && (fs.statSync(sinkPath).mode & 0o777) === 0o600, "the node wrote STRIPE_TEST_KEY into the env sink, mode 0600");
    check((await askOf(secretAsk!, "answered"))?.evidence === `fingerprint ${fingerprint}`, `${secretAsk} closed with its fingerprint`);
    ok(`1. secret ${secretAsk}: sealed client side, saved on ${MACHINE}; fingerprint ${fingerprint}`);

    // 3. Checklist with a verify check: ticked done before the step is done fails and reopens; after, it passes.
    const flag = path.join(lab.dir, "flag");
    let cursor = await lab.cursor();
    const doAsk = /\bA\d+\b/u.exec(
      fleetd(
        "ask", "--kind", "do", "--key", "lab.m8.flag", "--class", "irreversible", "--text", "Create the M8 lab flag file", "--blocks", "the M8 lab check",
        "--step", JSON.stringify({ text: "Create the flag file", where: MACHINE, command: `touch ${flag}` }),
        "--verify", JSON.stringify({ type: "cmd", machineId: MACHINE, argv: ["test", "-f", flag], expectExit: 0 }),
      ),
    )?.[0];
    check(doAsk, "fleetd ask --kind do filed an ask");
    // It blocks an irreversible step: urgent, so the app notifies even in quiet hours.
    const created = await lab.waitEvent(`${doAsk} created`, 30_000, { cursor, types: ["ask.created"], match: (e) => e.data?.askId === doAsk });
    check(created.event.attention === "urgent", `${doAsk}'s ask.created carries attention "urgent": ${JSON.stringify(created.event.attention)}`);

    cursor = await lab.cursor();
    const tick = await app.item(doAsk!);
    check(tick?.ask.steps?.[0]?.command === `touch ${flag}`, "the checklist shows its copyable command");
    check((await app.call("inbox_reply", tick!.raw("done"))).parsed === true, "ticked done");
    const reopened = await lab.waitEvent(`${doAsk} reopened`, 60_000, { cursor, types: ["ask.created"], match: (e) => e.data?.askId === doAsk && e.data?.reopened === true });
    const evidence = String((await app.item(doAsk!))?.ask.evidence);
    check(evidence.startsWith("ticked done, but its check failed") && reopened.event.attention === "urgent", `reopened, urgent, with the failing evidence: ${JSON.stringify(evidence)}`);
    fs.writeFileSync(flag, "");
    check((await app.call("inbox_reply", (await app.item(doAsk!))!.raw("done"))).parsed === true, "ticked done again");
    const verified = await lab.until(`${doAsk} verified`, 60_000, async () => {
      const ask = await askOf(doAsk!, "answered");
      if (ask?.evidence?.startsWith("verified:")) return ask;
      await callTool("events_wait", { cursor: await lab.cursor(), timeoutSec: 5 });
      return undefined;
    });
    ok(`3. checklist ${doAsk}: urgent; the first tick reopened it ("${evidence.split("\n")[0]}"), the second passed: ${verified.evidence}`);

    // 2. Approve ask. The lead: an earlier scenario's, else a fresh one now.
    const outcome = (await callTool("project_get", ref)).body;
    let leadThread = outcome.lead?.threadId as string | undefined;
    let turns = 0;
    if (leadThread === undefined) {
      const from = await lab.cursor();
      const started = await callTool("lead_start", { ...ref, model: MODEL, effort: "low" });
      check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
      leadThread = started.body.threadId as string;
      await lab.waitEvent("lead start turn", TURN_MS, { cursor: from, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) });
      turns++;
      ok(`lead ${leadThread} started (${MODEL})`);
    }
    const gatedFile = path.join(lab.dir, "fleetd-gated-test");
    const argv = ["sh", "-c", `echo deployed > ${gatedFile}`];
    const gatedAsk = /\bA\d+\b/u.exec(fleetd("gated", "run", "--class", "irreversible", "--argv", JSON.stringify(argv), "--reason", "prod deploy test"))?.[0];
    check(gatedAsk, "fleetd gated run filed an approve ask");
    const approve = await app.item(gatedAsk!);
    check(JSON.stringify(approve?.ask.gated?.argv) === JSON.stringify(argv) && approve?.ask.gated?.cwd === root, `${gatedAsk} shows the exact argv and the workspace as cwd`);
    const byAgent = await callTool("inbox_reply", approve!.raw("go"));
    check(byAgent.isError && byAgent.body.code === "forbidden", `an agent key's "go" is refused: ${byAgent.body.message}`);
    cursor = await lab.cursor();
    check((await app.call("inbox_reply", approve!.raw("go"))).parsed === true, "Approve");
    const ran = await lab.waitEvent("gated.ran", 60_000, { cursor, types: ["gated.ran"], match: (e) => e.data?.askId === gatedAsk });
    check(ran.event.data.exitCode === 0 && ran.event.data.by === "human:lab-desktop", `gated.ran: ${JSON.stringify(ran.event.data)}`);
    check(fs.readFileSync(gatedFile, "utf8") === "deployed\n", "the node ran the stored argv");
    const done = await askOf(gatedAsk!, "answered");
    check(String(done?.evidence).startsWith(`exit 0 on ${MACHINE}, approved by human:lab-desktop`), `evidence: ${JSON.stringify(done?.evidence)}`);
    const woken = await lab.waitEvent("the lead woken with the result", 120_000, {
      cursor: ran.cursor,
      types: ["lead.woken"],
      match: (e) => e.threadId === leadThread && (e.data?.triggers as Array<string> | undefined)?.includes("answer") === true,
    });
    await lab.waitEvent("the lead's wake turn", TURN_MS, { cursor: woken.cursor, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) });
    ok(`2. approval ${gatedAsk}: refused to an agent, run after Approve (${done?.evidence?.split("\n")[0]}); ${woken.event.summary}`);

    // 1b. The value appears nowhere but the sink: hub DB files, hub and node logs, every event, the node homes.
    const events = await allEvents(0);
    const places: Array<[string, string]> = [
      ...filesUnder(lab.hubHome),
      ...filesUnder(path.join(RUN, "logs")),
      ...fs.readdirSync(RUN).filter((d) => d.startsWith("node-")).flatMap((d) => filesUnder(path.join(RUN, d))),
      ["events", JSON.stringify(events)],
    ];
    const hits = places.filter(([, text]) => text.includes(VALUE)).map(([where]) => where);
    check(hits.length === 0, `the secret is in ${hits.join(", ")}`);
    ok(`1b. the plaintext is in none of ${places.length} places searched (hub db and files, ${events.length} events, hub/node logs, node homes)`);

    const leadTurns = (await allEvents(scenarioStart, { machineId: MACHINE, types: ["thread.completed"] })).filter((e) => e.threadId === leadThread).length;
    ok(`m8: ${Math.max(turns, leadTurns)} lead turn(s) in this scenario`);
  } finally {
    app.close();
    fs.rmSync(path.join(lab.dir, "secrets"), { recursive: true, force: true });
  }
}
