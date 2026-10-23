// Steering mid-run (`steer`): a lead on lab-a is redirected while a 25 s Bash call runs. ⌘Enter (`now`) stops
// that call and the lead's next action is the redirect; Enter (`queue`) waits for the call to return and lands at
// that boundary, not at the turn's end. Each steer's receipt must reach acknowledged, and the CLI's `fleetd steer
// --wait` must too. Prints the latency of each mode from the steer's send. About six tiny lead turns.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type Body, callToolWith, chatOrder, cli, fleetdCommand, HUB_URL, type Lab, nodeHome, scrubbedEnv } from "./harness.ts";

const MACHINE = "lab-a";
const TURN_MS = 240_000;
const SLOW = "for i in $(seq 25); do sleep 1; done; echo slow-done";
const STEER_EVENTS = ["steer.queued", "steer.delivered", "steer.acknowledged", "steer.unacknowledged", "steer.withdrawn", "steer.failed"];

interface Seen {
  /** This process's clock when the line was read. */
  readonly at: number;
  /** The node's own stamp, on one clock for the whole transcript. */
  readonly ms: number;
  readonly dir: string;
  readonly msg: Body;
}

/** Tails the node's transcript of claude's stdin and stdout, stamping each line with this clock when read. */
class Tail {
  readonly lines: Array<Seen> = [];
  private offset = 0;
  private buf = "";
  private readonly timer: NodeJS.Timeout;
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    // unref: a failed check must not leave the lab run hanging on this timer.
    this.timer = setInterval(() => this.read(), 10).unref();
  }
  read() {
    if (!fs.existsSync(this.file)) return;
    const size = fs.statSync(this.file).size;
    if (size <= this.offset) return;
    const fd = fs.openSync(this.file, "r");
    const chunk = Buffer.alloc(size - this.offset);
    fs.readSync(fd, chunk, 0, chunk.length, this.offset);
    fs.closeSync(fd);
    this.offset = size;
    const parts = (this.buf + chunk.toString("utf8")).split("\n");
    this.buf = parts.pop() ?? "";
    const now = Date.now();
    for (const p of parts) {
      if (!p.startsWith("{")) continue;
      try {
        const rec = JSON.parse(p) as Body;
        this.lines.push({ at: now, ms: Number(rec.ms), dir: rec.dir, msg: rec.msg ?? {} });
      } catch {
        /* a partial line */
      }
    }
  }
  stop() {
    clearInterval(this.timer);
  }
  async waitFor(what: string, from: number, pred: (s: Seen) => boolean, ms = TURN_MS): Promise<Seen> {
    const end = Date.now() + ms;
    for (;;) {
      this.read();
      const hit = this.lines.find((s) => s.at >= from && pred(s));
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out after ${ms / 1000}s: ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

const json = (m: Body) => JSON.stringify(m);
/**
 * An assistant line with a tool call in it. Claude streams each content block as its own line, and every line of a
 * message carries its `stop_reason`, so a text or thinking block of a message that ends in a tool call says
 * "tool_use" too: only the content block counts.
 */
const toolUses = (s: Seen): Array<Body> =>
  s.dir === "out" && s.msg.type === "assistant" ? ((s.msg.message?.content ?? []) as Array<Body>).filter((b) => b.type === "tool_use") : [];
const toolUseOf = (marker: string) => (s: Seen) => toolUses(s).some((b) => json(b).includes(marker));
const toolResultAfter = (s: Seen) => s.dir === "out" && s.msg.type === "user" && json(s.msg).includes("tool_result");

export async function steerMidTurn(lab: Lab) {
  const { callTool, check, ok, log } = lab;
  await lab.waitLive(MACHINE);
  const projectId = (await callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === MACHINE)?.projectId as string;
  check(projectId, `${MACHINE} has a project`);
  const ref = { machineId: MACHINE, projectId };

  // A steer speaks for the human: a human key, kept in a file for the CLI leg.
  const humanKey = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", lab.hubHome, "--human", "--name", "lab-steer"))?.[0];
  check(humanKey, "hub key create --human printed a key");
  fs.mkdirSync(lab.dir, { recursive: true });
  const keyFile = path.join(lab.dir, "human.key");
  fs.writeFileSync(keyFile, `${humanKey}\n`, { mode: 0o600 });
  const human = new Client({ name: "fleetd-test-lab-steer", version: "0" });
  await human.connect(
    new StreamableHTTPClientTransport(new URL(`${HUB_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${humanKey}` } } }) as Transport,
  );
  const humanCall = callToolWith(() => human);

  const turnDone = async (threadId: string, cursor: number, what: string) => {
    const { event } = await lab.waitEvent(`lead turn: ${what}`, TURN_MS, {
      cursor,
      machineId: MACHINE,
      match: (e) => e.threadId === threadId && ["thread.completed", "thread.failed", "thread.interrupted"].includes(e.type),
    });
    check(event.type === "thread.completed", `lead turn (${what}) ended with ${event.type}: ${event.summary}`);
    ok(`lead turn (${what}) completed`);
    return event.seq as number;
  };
  const steerEvent = (what: string, cursor: number, steerId: string, type: string, ms: number) =>
    lab.waitEvent(what, ms, { cursor, types: STEER_EVENTS, match: (e) => e.data?.steerId === steerId && (e.type === type || ["steer.failed", "steer.withdrawn", "steer.unacknowledged"].includes(e.type)) });
  const send = async (workstreamId: string, text: string, mode: "queue" | "now") => {
    const sent = await humanCall("steer_send", { target: { workstreamId }, text, mode, clientRequestId: randomUUID() });
    check(!sent.isError && /^S[1-9][0-9]*$/u.test(sent.body.id) && sent.body.stage === "queued", `steer_send ${mode}: ${JSON.stringify(sent.body)}`);
    return sent.body as Body;
  };
  const actionsSince = async (threadId: string, iso: string) =>
    ((await callTool("actions_list", { machineId: MACHINE, threadId, limit: 50 })).body.actions as Array<Body>)
      .filter((a) => Date.parse(a.at) >= Date.parse(iso))
      .toReversed();

  // 1. A lead with one running order and nothing else to do.
  let cursor = await lab.cursor();
  const started = await callTool("lead_start", ref);
  check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
  const threadId = started.body.threadId as string;
  const tail = new Tail(path.join(nodeHome(MACHINE), "transcripts", `${threadId}.jsonl`));
  // A lead m3 left running is already idle; a new one has its start turn to finish.
  if (started.body.state !== "idle") cursor = await turnDone(threadId, cursor, "start");
  const { workstreamId } = await chatOrder(lab, ref, "lab steering: open its workstream with workstream_open, freeze a one-line brief with `fleetd brief create` so it is running, then wait for my notes; spawn no tasks");
  await lab.waitEvent(`workstream.running for ${workstreamId}`, TURN_MS, { cursor, machineId: MACHINE, types: ["workstream.running"], match: (e) => e.data?.workstreamId === workstreamId });
  cursor = await turnDone(threadId, cursor, "the chat turn");
  ok(`${workstreamId} running; lead ${threadId} idle`);

  /** Has the idle lead start the slow loop, and returns once it has been running for 2 s. */
  const startSlow = async () => {
    const from = Date.now();
    const c = await lab.cursor();
    const slow = await send(workstreamId, `Run exactly this with Bash and wait for it: \`${SLOW}\`, then reply SLOW-DONE.`, "queue");
    await steerEvent(`${slow.id} delivered`, c, slow.id, "steer.delivered", 30_000);
    const toolUse = await tail.waitFor("the lead runs the slow loop", from, toolUseOf("slow-done"));
    await new Promise((r) => setTimeout(r, 2000));
    return { c, toolUse };
  };

  // 2. ⌘Enter mid-turn: the loop is stopped and the lead's next action is the redirect.
  const now = await (async () => {
    const { c, toolUse } = await startSlow();
    const marker = `redirected-${randomUUID().slice(0, 8)}`;
    const t0 = Date.now();
    const steer = await send(workstreamId, `Change of plan: stop that. Run \`echo ${marker}\` with Bash, then reply REDIRECTED.`, "now");
    const sentMs = Date.now() - t0;
    const delivered = (await steerEvent(`${steer.id} delivered`, c, steer.id, "steer.delivered", 30_000)).event;
    check(delivered.type === "steer.delivered", `${steer.id} delivered, not ${delivered.type}: ${JSON.stringify(delivered.data)}`);
    const deliveredMs = Date.parse(delivered.at) - t0;
    const listed = ((await humanCall("steers_list", { workstreamId })).body.steers as Array<Body>).find((s) => s.id === steer.id);
    check(listed?.how === "stopped" && /slow-done|seq 25|sleep/u.test(listed.stoppedTool ?? ""), `${steer.id} delivered by stopping the loop: ${JSON.stringify(listed)}`);
    check(deliveredMs <= 3000, `${steer.id} delivered ${deliveredMs} ms after the send (≤ 3 s)`);
    const firstTool = await tail.waitFor("the lead's first tool call after the steer", t0, (s) => toolUses(s).length > 0, 60_000);
    const calls = toolUses(firstTool).map((b) => ({ tool: b.name, input: b.input }));
    check(json(calls).includes(marker), `the lead's next tool call is the redirect: ${json(calls).slice(0, 600)}`);
    const acked = (await steerEvent(`${steer.id} acknowledged`, c, steer.id, "steer.acknowledged", 30_000 - (Date.now() - t0))).event;
    check(acked.type === "steer.acknowledged" && /^S[1-9][0-9]*:/u.test(acked.data?.excerpt ?? ""), `${steer.id} acknowledged with "S<n>:": ${JSON.stringify(acked.data)}`);
    const ackMs = Date.parse(acked.at) - t0;
    const done = await turnDone(threadId, c, "redirect");
    // The run the steer cut short is superseded: not an interruption, so no thread.interrupted for it.
    const interrupted = await callTool("events_wait", { cursor: c, timeoutSec: 0, types: ["thread.interrupted"], machineId: MACHINE });
    check(!(interrupted.body.events as Array<Body>).some((e) => e.threadId === threadId), `no thread.interrupted for the superseded run: ${JSON.stringify(interrupted.body.events)}`);
    const actions = await actionsSince(threadId, new Date(toolUse.at - 1000).toISOString());
    const loop = actions.find((a) => a.summary.includes("slow-done"));
    // The node lists the lead's thinking as actions too ("Thinking: …", node/runner/claude/mapper.rs); the next thing
    // the lead does is its next tool run.
    const after = actions.filter((a) => Date.parse(a.at) >= Date.parse(delivered.at) && !String(a.summary).startsWith("Thinking: "));
    check(loop?.status === "failed" && after[0]?.summary.includes(`echo ${marker}`), `the loop was cut and the next action is the redirect: ${JSON.stringify(actions)}`);
    ok(`⌘Enter: ${steer.id} stopped "${listed!.stoppedTool}" ${deliveredMs} ms after the send; next action \`echo ${marker}\`; acknowledged "${acked.data.excerpt}"`);
    return { done, row: { mode: "now", sent_ms: sentMs, delivered_ms: deliveredMs, next_tool_call_ms: firstTool.at - t0, acknowledged_ms: ackMs, into_tool_ms: t0 - toolUse.at } };
  })();
  cursor = now.done;

  // The CLI leg: the same redirect between turns, followed with --wait.
  {
    const marker = `cli-${randomUUID().slice(0, 8)}`;
    const [bin, args] = fleetdCommand(["steer", workstreamId, `Run \`echo ${marker}\` with Bash, then reply DONE.`, "--wait", "--key-file", keyFile, "--hub", HUB_URL]);
    let out = "";
    try {
      out = execFileSync(bin, args, { env: scrubbedEnv(), encoding: "utf8", timeout: 120_000 });
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      check(false, `fleetd steer --wait exited ${e.status}: ${e.stdout ?? ""}${e.stderr ?? ""}`);
    }
    check(/S\d+ queued/u.test(out) && /S\d+ acknowledged/u.test(out), `fleetd steer --wait printed the receipts: ${out}`);
    ok(`fleetd steer --wait exited 0:\n${out.trimEnd()}`);
    cursor = await turnDone(threadId, cursor, "cli steer");
  }

  // 3. Enter mid-turn: it waits for the loop to return, then lands at that boundary, not at the turn's end.
  const queue = await (async () => {
    const { c, toolUse } = await startSlow();
    const marker = `boundary-${randomUUID().slice(0, 8)}`;
    const t0 = Date.now();
    const steer = await send(workstreamId, `Also run \`echo ${marker}\` with Bash, then reply BOUNDARY.`, "queue");
    const delivered = (await steerEvent(`${steer.id} delivered`, c, steer.id, "steer.delivered", 60_000)).event;
    check(delivered.type === "steer.delivered", `${steer.id} delivered, not ${delivered.type}`);
    // The hub can hear of the delivery before this tail reads the lines, so wait for them; time the boundary on the
    // transcript's own clock, from the tool result to claude taking the steer in.
    const result = await tail.waitFor("the loop's tool result", toolUse.at, toolResultAfter, 10_000);
    const begun = await tail.waitFor(`${steer.id} started`, toolUse.at, (s) => s.msg.type === "command_lifecycle" && s.msg.command_uuid === steer.runId && s.msg.state === "started", 10_000);
    const deliveredMs = Date.parse(delivered.at) - t0;
    const afterResultMs = begun.ms - result.ms;
    const listed = ((await humanCall("steers_list", { workstreamId })).body.steers as Array<Body>).find((s) => s.id === steer.id);
    check(listed?.how === "boundary", `${steer.id} delivered at the boundary: ${JSON.stringify(listed)}`);
    check(afterResultMs <= 2000, `${steer.id} delivered ${afterResultMs} ms after the loop returned (≤ 2 s)`);
    const acked = (await steerEvent(`${steer.id} acknowledged`, c, steer.id, "steer.acknowledged", 60_000)).event;
    check(acked.type === "steer.acknowledged", `${steer.id} acknowledged: ${JSON.stringify(acked.data)}`);
    const done = await turnDone(threadId, c, "boundary");
    const loop = (await actionsSince(threadId, new Date(toolUse.at - 1000).toISOString())).find((a) => a.summary.includes("slow-done"));
    check(loop?.status === "completed", `the loop ran to the end: ${JSON.stringify(loop)}`);
    ok(`Enter: ${steer.id} delivered ${afterResultMs} ms after the loop returned (${deliveredMs} ms after the send); acknowledged`);
    return { done, row: { mode: "queue", delivered_ms: deliveredMs, after_tool_result_ms: afterResultMs, acknowledged_ms: Date.parse(acked.at) - t0, into_tool_ms: t0 - toolUse.at } };
  })();

  tail.stop();
  await human.close().catch(() => undefined);
  for (const row of [now.row, queue.row]) log(`MEASURE steer ${JSON.stringify(row)}`);
}
