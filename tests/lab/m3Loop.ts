// M3 "done when" 1-2, end to end: a lead on lab-a starts on the current prompt with its state block, and a chat
// message becomes a draft workstream whose brief the lead freezes from its own shell (`fleetd` on its PATH, reaching
// the hub through lab-a's node socket). Two lead turns, each tiny: start and the chat turn.
import { type Body, chatOrder, type Lab, MODEL } from "./harness.ts";

const MACHINE = "lab-a";
// The v1 prompt has the lead delegate at once; m5 decides when tasks run, so this lead registers the brief only.
const INTENT = "add a /health endpoint (lab run: open its workstream with workstream_open and freeze its brief with `fleetd brief create` so it is running, then stop; spawn no tasks until told)";
const TURN_MS = 240_000;

export async function m3Loop(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  const projectId = (await callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === MACHINE)?.projectId as string;
  check(projectId, `${MACHINE} has a project`);
  const ref = { machineId: MACHINE, projectId };

  let turns = 0;
  /** Waits for the lead thread's next run after `cursor` to end; every run is one lead turn. */
  const turnDone = async (threadId: string, cursor: number, what: string) => {
    const { event } = await lab.waitEvent(`lead turn: ${what}`, TURN_MS, {
      cursor,
      machineId: MACHINE,
      match: (e) => e.threadId === threadId && ["thread.completed", "thread.failed", "thread.interrupted"].includes(e.type),
    });
    turns += 1;
    check(event.type === "thread.completed", `lead turn (${what}) ended with ${event.type}: ${event.summary}`);
    ok(`lead turn ${turns} (${what}) completed`);
    return event.seq as number;
  };

  // 1. lead_start launches the lead with the current prompt; project_get shows it idle once its first turn ends.
  let cursor = await lab.cursor();
  const started = await callTool("lead_start", ref);
  check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
  const threadId = started.body.threadId as string;
  ok(`lead_start ${MACHINE}/${projectId} (${MODEL}, high) -> thread ${threadId}, state ${started.body.state}`);
  const again = (await callTool("lead_start", ref)).body;
  check(again.threadId === threadId, `a second lead_start returns the same lead: ${JSON.stringify(again)}`);
  const leadStarted = await lab.waitEvent("lead.started", 10_000, { cursor, machineId: MACHINE, types: ["lead.started"] });
  const { promptRef, textSha } = (leadStarted.event.data ?? {}) as { promptRef?: string; textSha?: string };
  check(/^lead\.start@[0-9a-f]{10}$/u.test(promptRef ?? "") && /^[0-9a-f]{40}$/u.test(textSha ?? ""), `lead.started names its prompt and first message: ${JSON.stringify(leadStarted.event)}`);
  // What the lead was told, byte for byte: kept by the hub, with the refs it is pinned to.
  const told = (await callTool("session_prompt_get", { machineId: MACHINE, threadId })).body;
  check(
    told.session?.textSha === textSha && told.session.text.includes("# project ") && told.session.refs.some((r: Body) => r.id === "lead.start" && r.ref === promptRef),
    `session_prompt_get returns the lead's first message: ${JSON.stringify(told).slice(0, 300)}`,
  );
  ok(`lead.started ${promptRef}, first message ${textSha?.slice(0, 12)}… kept (session_prompt_get)`);
  cursor = await turnDone(threadId, cursor, "start");
  // thread_tail keeps a long message's end: the digest. Its text is checked above (session_prompt_get).
  const firstTail = (await callTool("thread_tail", { machineId: MACHINE, threadId, n: 10, kinds: ["message"] })).body;
  check(
    (firstTail.items as Array<Body> | undefined)?.some((i) => i.role === "user" && i.text.includes("# project ")),
    `the lead's first message is the lead.start prompt plus the digest: ${JSON.stringify(firstTail).slice(0, 500)}`,
  );
  const outcome = (await callTool("project_get", ref)).body;
  check(outcome.lead?.threadId === threadId && outcome.lead.state === "idle", `project_get lead: ${JSON.stringify(outcome.lead)}`);
  ok(`project_get: lead {threadId: ${outcome.lead.threadId}, state: ${outcome.lead.state}}`);

  // 2. A chat message: the lead opens a draft with workstream_open and runs `fleetd brief create`: running, frozen hash.
  const order = await chatOrder(lab, ref, INTENT);
  const workstreamId = order.workstreamId;
  const running = await lab.waitEvent(`workstream.running for ${workstreamId}`, TURN_MS, { cursor, machineId: MACHINE, types: ["workstream.running"] });
  const created = await lab.waitEvent(`workstream.created for ${workstreamId}`, 10_000, { cursor, types: ["workstream.created"], match: (e) => e.data?.workstreamId === workstreamId });
  check(created.event.seq < running.event.seq, `${workstreamId} starts as a draft: created (seq ${created.event.seq}) before running (seq ${running.event.seq})`);
  ok(`chat_send -> the lead opened ${workstreamId} (a draft)`);
  await turnDone(threadId, order.cursor, "the chat turn");
  const registered = (await callTool("workstream_get", { workstreamId })).body.workstream;
  check(registered.state === "running" && /^[0-9a-f]{64}$/u.test(registered.briefHash ?? ""), `brief frozen: ${JSON.stringify(registered)}`);
  ok(`the lead ran fleetd brief create: ${workstreamId} running, briefHash ${registered.briefHash.slice(0, 12)}… (event seq ${running.event.seq})`);

  // 3-4 (an ask from the lead's shell, the terse inbox reply as a decision, the re-ask answered from the log, a naming
  // ask refused) went with the questions tool; the lead now asks in chat, and `chat` terse checks the answer is logged
  // with decide and never asked again.
  ok(`M3 loop used ${turns} lead turns (${MODEL})`);
}
