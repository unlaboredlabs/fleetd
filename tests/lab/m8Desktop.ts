// M8 "done when" on lab-a, through the desktop app's protocol: a human key from `fleetd hub key create --human` on
// the hub's /app WebSocket, sending the same frames and tool calls the app sends. A secret request is sealed client
// side with libsodium's crypto_box_seal, as the app seals it, and lands 0600 on the node, its value found nowhere in
// the hub's files, logs or events; a gated irreversible command is urgent, refused to an agent key, and runs after a
// person's Approve, waking the lead with its exit code. The requests are filed from the project's shell as a lead
// would, so they cost no turns; a lead is started only if none exists, just before the approval, so a run alone costs
// two turns (lead start, the approval's wake).
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sodium from "libsodium-wrappers";
import { type Body, cli, fleetdCommand, HUB_PORT, type Lab, MACHINES, MODEL, nodeHome, nodeSock, RUN, scrubbedEnv, userMessages } from "./harness.ts";
import { CLONE } from "./m7Train.ts";

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
  return { call, close: () => ws.close() };
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
  // The hub keeps m7's deleted lab repo project in its list; this scenario uses lab-a's own repo.
  const projectId = (await callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === MACHINE && p.workspaceRoot !== CLONE)?.projectId as string;
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
      env: { ...scrubbedEnv(), PWD: root, FLEETD_NODE_SOCK: nodeSock(MACHINE) },
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

  // The desktop app's key: a person's, so its answers count as the human's.
  const key = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", lab.hubHome, "--human", "--name", "lab-desktop"))?.[0];
  check(key, "hub key create --human printed a key");
  const app = await appSession(key!);
  try {
    const policy = await app.call("attention_policy");
    check(policy.coalesceSec === 1200 && Array.isArray(policy.quiet), `attention_policy: ${JSON.stringify(policy)}`);
    ok(`0. connected on /app with a --human key; attention_policy coalesces ${policy.coalesceSec} s, ${policy.quiet.length} quiet window(s) ahead`);

    /** The project's chat item for request `id`, as the app reads it. */
    const itemOf = async (id: string) =>
      ((await app.call("chat_history", { projectRef: ref, limit: 100 })).messages as Array<Body>).find((m) => m.item?.requestId === id)?.item as Body | undefined;
    /** The chat item once it reaches `state`: the chat shows a request's change from its request.updated, just after. */
    const itemIn = (id: string, state: string) =>
      lab.until(`${id}'s chat item ${state}`, 30_000, async () => {
        const item = await itemOf(id);
        if (item?.state === state) return item;
        await new Promise((r) => setTimeout(r, 250));
        return undefined;
      });

    // 1. A secret request, sealed client side to the node's box key.
    const sinkDir = path.join(lab.dir, "secrets");
    fs.mkdirSync(sinkDir, { recursive: true });
    const sinkPath = path.join(sinkDir, ".env");
    fs.writeFileSync(sinkPath, "OTHER=1\n");
    const secretAsk = /\bQ\d+\b/u.exec(fleetd("request", "secret", "--key", "stripe.test_key", "--sink", `env:${MACHINE}:${sinkPath}`, "--text", "Need the Stripe test key"))?.[0];
    check(secretAsk, "fleetd request secret filed a request");
    const asked = await itemIn(secretAsk!, "open");
    check(asked?.kind === "secret_request" && asked.state === "open" && asked.name === "stripe.test_key", `${secretAsk} is an open secret item in the chat: ${JSON.stringify(asked)}`);
    const machine = ((await app.call("fleetd_status")).machines as Array<Body>).find((m) => m.machineId === MACHINE);
    check(typeof machine?.boxPubKey === "string", `${MACHINE} has a box key`);
    await sodium.ready;
    const plaintext = sodium.from_string(VALUE);
    const sealed = sodium.to_base64(sodium.crypto_box_seal(plaintext, sodium.from_base64(machine!.boxPubKey, sodium.base64_variants.ORIGINAL)), sodium.base64_variants.ORIGINAL);
    sodium.memzero(plaintext);
    const saved = await app.call("secret_submit", { requestId: secretAsk, sealed });
    const fingerprint = crypto.createHash("sha256").update(VALUE).digest("hex").slice(0, 8);
    check(saved.fingerprint === fingerprint, `secret_submit answered fingerprint ${saved.fingerprint}`);
    const sink = fs.readFileSync(sinkPath, "utf8");
    check(sink === `OTHER=1\nSTRIPE_TEST_KEY=${VALUE}\n` && (fs.statSync(sinkPath).mode & 0o777) === 0o600, "the node wrote STRIPE_TEST_KEY into the env sink, mode 0600");
    const stored = await itemIn(secretAsk!, "stored");
    check(stored?.state === "stored" && stored.fingerprint === fingerprint, `${secretAsk} stored with its fingerprint: ${JSON.stringify(stored)}`);
    ok(`1. secret ${secretAsk}: sealed client side, saved on ${MACHINE}; fingerprint ${fingerprint}`);
    // (3., the checklist ask with a verify check, went with the questions tool: a human check is a chat line now.)

    // 2. A gated command. The lead: an earlier scenario's, else a fresh one now.
    const outcome = (await callTool("project_get", ref)).body;
    let leadThread = outcome.lead?.threadId as string | undefined;
    let turns = 0;
    if (leadThread === undefined) {
      const from = await lab.cursor();
      const started = await callTool("lead_start", ref);
      check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
      leadThread = started.body.threadId as string;
      await lab.waitEvent("lead start turn", TURN_MS, { cursor: from, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) });
      turns++;
      ok(`lead ${leadThread} started (${MODEL})`);
    }
    const gatedFile = path.join(lab.dir, "fleetd-gated-test");
    const argv = ["sh", "-c", `echo deployed > ${gatedFile}`];
    let cursor = await lab.cursor();
    const gatedAsk = /\bQ\d+\b/u.exec(fleetd("gated", "run", "--class", "irreversible", "--argv", JSON.stringify(argv), "--reason", "prod deploy test"))?.[0];
    check(gatedAsk, "fleetd gated run filed a request");
    // It runs an irreversible command: urgent, so the app notifies even in quiet hours.
    const opened = await lab.waitEvent(`${gatedAsk} opened`, 30_000, { cursor, types: ["request.opened"], match: (e) => e.data?.requestId === gatedAsk });
    check(opened.event.attention === "urgent", `${gatedAsk}'s request.opened carries attention "urgent": ${JSON.stringify(opened.event.attention)}`);
    const approve = await itemIn(gatedAsk!, "open");
    check(
      approve?.kind === "command_approval" && approve.state === "open" && JSON.stringify(approve.gated?.argv) === JSON.stringify(argv) && approve.gated?.cwd === root,
      `${gatedAsk} shows the exact argv and the workspace as cwd: ${JSON.stringify(approve)}`,
    );
    const byAgent = await callTool("approval_answer", { requestId: gatedAsk, decision: "approve" });
    check(byAgent.isError && byAgent.body.code === "forbidden", `an agent key's approve is refused: ${JSON.stringify(byAgent.body)}`);
    cursor = await lab.cursor();
    await app.call("approval_answer", { requestId: gatedAsk, decision: "approve" });
    const ran = await lab.waitEvent(`${gatedAsk} ran`, 60_000, { cursor, types: ["request.updated"], match: (e) => e.data?.requestId === gatedAsk && ["ran", "failed"].includes(e.data?.state) });
    const done = ran.event.data.state === "ran" ? await itemIn(gatedAsk!, "ran") : await itemOf(gatedAsk!);
    check(ran.event.data.state === "ran" && ran.event.data.by === "human:lab-desktop" && done?.exitCode === 0, `ran, approved by the person: ${JSON.stringify({ event: ran.event.data, item: done })}`);
    check(fs.readFileSync(gatedFile, "utf8") === "deployed\n", "the node ran the stored argv");
    const woken = await lab.waitEvent("the lead woken with the result", 120_000, {
      cursor: ran.cursor,
      types: ["lead.woken"],
      match: (e) => e.threadId === leadThread,
    });
    await lab.waitEvent("the lead's wake turn", TURN_MS, { cursor: woken.cursor, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) });
    const line = userMessages(MACHINE, leadThread).flatMap((t) => t.split("\n")).find((l) => l.startsWith(`- ${gatedAsk} your command`));
    check(line?.includes(`ran: exit 0 on ${MACHINE}, approved by human:lab-desktop`), `the lead's wake carries the result: ${JSON.stringify(line)}`);
    ok(`2. approval ${gatedAsk}: refused to an agent, run after Approve; the lead's wake: ${line}`);

    // 1b. The value appears nowhere but the sink: hub DB files, hub and node logs, every event, the node homes.
    const events = await allEvents(0);
    const places: Array<[string, string]> = [
      ...filesUnder(lab.hubHome),
      ...filesUnder(path.join(RUN, "logs")),
      ...MACHINES.flatMap((m) => filesUnder(nodeHome(m.id))),
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
