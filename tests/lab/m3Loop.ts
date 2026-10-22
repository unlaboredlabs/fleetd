// M3 "done when" 1-4, end to end: a haiku lead on lab-a registers a brief and files an ask from its own shell
// (`fleetd` on its PATH, reaching the hub through lab-a's node socket), the human's terse reply becomes a decision
// delivered to the lead inline, the same key is then answered from the log, and a naming question is refused.
// Five lead turns, each tiny: start, the intent wake, one ask, the answer wake, the re-ask plus refusal.
import { randomUUID } from "node:crypto";
import { type Body, chatOrder, type Lab, MODEL } from "./harness.ts";

const MACHINE = "lab-a";
// The v1 prompt has the lead delegate at once; m5 decides when tasks run, so this lead registers the brief only.
const INTENT = "add a /health endpoint (lab run: open its workstream with workstream_open and register the brief, then stop; spawn no tasks until told)";
const ASK = `fleetd ask --key api.health.path --class product --text "Path?" --option '/healthz|/healthz|Matches the probe default.' --option '/health|/health|The probe config changes too.' --rec /healthz --why "The probe expects it." --proceeded`;
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
  const send = async (threadId: string, message: string) => {
    const sent = await callTool("thread_send", { machineId: MACHINE, threadId, message, clientRequestId: randomUUID() });
    check(!sent.isError && sent.body.queued === false, `thread_send to the lead: ${JSON.stringify(sent.body)}`);
  };

  // 1. lead_start launches the lead with the current prompt; project_get shows it idle once its first turn ends.
  let cursor = await lab.cursor();
  const started = await callTool("lead_start", { ...ref, model: MODEL, effort: "low" });
  check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
  const threadId = started.body.threadId as string;
  ok(`lead_start ${MACHINE}/${projectId} (${MODEL}, low) -> thread ${threadId}, state ${started.body.state}`);
  const again = (await callTool("lead_start", ref)).body;
  check(again.threadId === threadId, `a second lead_start returns the same lead: ${JSON.stringify(again)}`);
  const leadStarted = await lab.waitEvent("lead.started", 10_000, { cursor, machineId: MACHINE, types: ["lead.started"] });
  const { promptRef, textSha } = (leadStarted.event.data ?? {}) as { promptRef?: string; textSha?: string };
  check(/^lead\.start@[0-9a-f]{10}$/u.test(promptRef ?? "") && /^[0-9a-f]{40}$/u.test(textSha ?? ""), `lead.started names its prompt and first message: ${JSON.stringify(leadStarted.event)}`);
  // What the lead was told, byte for byte: kept by the hub, with the refs it is pinned to.
  const told = (await callTool("session_prompt_get", { machineId: MACHINE, threadId })).body;
  check(
    told.session?.textSha === textSha && told.session.text.includes("# fleetd digest:") && told.session.refs.some((r: Body) => r.id === "lead.start" && r.ref === promptRef),
    `session_prompt_get returns the lead's first message: ${JSON.stringify(told).slice(0, 300)}`,
  );
  ok(`lead.started ${promptRef}, first message ${textSha?.slice(0, 12)}… kept (session_prompt_get)`);
  cursor = await turnDone(threadId, cursor, "start");
  // thread_tail keeps a long message's end: the prompt's last tool line, then the digest.
  const firstTail = (await callTool("thread_tail", { machineId: MACHINE, threadId, n: 10, kinds: ["message"] })).body;
  check(
    (firstTail.items as Array<Body> | undefined)?.some(
      (i) => i.role === "user" && i.text.includes("`decisions_search`") && i.text.includes("# fleetd digest:"),
    ),
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
  cursor = await turnDone(threadId, order.cursor, "the chat turn");
  const registered = (await callTool("workstream_get", { workstreamId })).body.workstream;
  check(registered.state === "running" && /^[0-9a-f]{64}$/u.test(registered.briefHash ?? ""), `brief frozen: ${JSON.stringify(registered)}`);
  ok(`the lead ran fleetd brief create: ${workstreamId} running, briefHash ${registered.briefHash.slice(0, 12)}… (event seq ${running.event.seq})`);

  // 3. The lead files the ask from its shell; it lands in batch B1, published after the quiet window.
  await send(threadId, `Run this command once in your shell, exactly as written, then stop:\n${ASK} --workstream ${workstreamId}`);
  const askedFrom = cursor;
  cursor = await turnDone(threadId, cursor, "ask");
  const ready = await lab.waitEvent("batch.ready", 120_000, { cursor: askedFrom, types: ["batch.ready"] });
  const listed = (await callTool("asks_list")).body;
  const ask = (listed.asks as Array<Body>).find((a) => a.key === "api.health.path");
  check(ask?.batchId === "B1", `asks_list has api.health.path in B1: ${JSON.stringify(listed)}`);
  ok(`asks_list: ${ask!.askId} api.health.path is item ${ask!.number} of ${ask!.batchId} (${listed.asks.length} open; batch.ready seq ${ready.event.seq})`);

  // The reply is held for its 10 s undo window, then becomes Decision D1 and reaches the lead inline in its next wake.
  const phaseOf = async () =>
    ((await callTool("orders_board", { projectRef: ref })).body.orders as Array<Body>).find((o) => o.workstreamId === workstreamId)?.phase;
  const asked = await phaseOf();
  const replyFrom = await lab.cursor();
  const replied = (await callTool("inbox_reply", { raw: `${ask!.number} go` })).body;
  check(replied.parsed && replied.echo === `Logged: ${ask!.number} → /healthz (undo for 10 s)`, `inbox_reply: ${JSON.stringify(replied)}`);
  // The app refetches the order card on the ask's own event: the card leaves "needs you" within 1 s of the answer.
  const answeredAt = Date.now();
  const held = await lab.waitEvent(`ask.answered for ${ask!.askId}`, 1_000, { cursor: replyFrom, types: ["ask.answered"], match: (e) => e.data?.askId === ask!.askId });
  const answeredPhase = await phaseOf();
  const tookMs = Date.now() - answeredAt;
  check(
    asked === "waiting_on_you" && held.event.data.workstreamId === workstreamId && answeredPhase !== "waiting_on_you" && tookMs <= 1_000,
    `the order card leaves needs you within 1 s of the answer: ${asked} -> ${answeredPhase} in ${tookMs} ms (${JSON.stringify(held.event)})`,
  );
  ok(`${workstreamId}'s card: ${asked} -> ${answeredPhase} ${tookMs} ms after the answer (ask.answered seq ${held.event.seq})`);
  // Once the undo window passes the answer is final: ask.closed, then the decision.
  const closed = await lab.waitEvent(`ask.closed for ${ask!.askId}`, 60_000, { cursor: replyFrom, types: ["ask.closed"], match: (e) => e.data?.askId === ask!.askId });
  check(closed.event.data.workstreamId === workstreamId, `ask.closed names the order: ${JSON.stringify(closed.event)}`);
  const decision = (await callTool("decisions_search", { query: "api.health.path" })).body.decisions[0];
  check(decision?.key === "api.health.path" && decision.value === "/healthz" && decision.source === "agent", `decision: ${JSON.stringify(decision)}`);
  ok(`inbox_reply "${ask!.number} go": ${replied.echo}; D1 by ${decision.by} (source ${decision.source})`);
  const answerWake = await lab.waitEvent("lead.woken with the answer", 60_000, {
    cursor,
    machineId: MACHINE,
    types: ["lead.woken"],
    match: (e) => (e.data?.triggers ?? []).includes("answer"),
  });
  cursor = await turnDone(threadId, answerWake.event.seq, "answer wake");
  const wakes = (await callTool("thread_tail", { machineId: MACHINE, threadId, n: 20, kinds: ["message"] })).body.items as Array<Body>;
  // A long wake shows only its end here, so look for the decision line and the trigger line rather than the top.
  const answerMessage = wakes.find((i) => i.role === "user" && i.text.includes("settled 1 of your asks"));
  check(
    answerMessage !== undefined && /api\.health\.path (→|=) \/healthz/u.test(answerMessage.text),
    `the answer wake carries the answer inline: ${JSON.stringify(wakes).slice(0, 800)}`,
  );
  ok("the answer wake carried api.health.path = /healthz (D1) inline");

  // 4. Asking the same key again is answered from the log; a naming question is refused.
  await send(
    threadId,
    // The prompt says never to re-ask a decided key, so a lead may skip the first command unless told this is a check.
    `This is a lab check of fleetd's decision log: run both commands below in your shell, exactly as written, one after the other, even though the first key is already decided, then stop:\n${ASK}\nfleetd ask --key api.health.name --class naming --text "Name?" --rec "health"`,
  );
  const reaskFrom = cursor;
  cursor = await turnDone(threadId, cursor, "re-ask and naming");
  const auto = await lab.waitEvent("ask.auto for api.health.path", 10_000, {
    cursor: reaskFrom,
    types: ["ask.auto"],
    match: (e) => e.data?.key === "api.health.path",
  });
  check(auto.event.data.decisionId === "D1", `answered from D1: ${JSON.stringify(auto.event)}`);
  const open = ((await callTool("asks_list")).body.asks as Array<Body>).filter((a) => a.key === "api.health.path");
  check(open.length === 0, `the repeat never reached a batch: ${JSON.stringify(open)}`);
  ok(`second fleetd ask answered from the log: ${auto.event.summary}`);
  const actions = (await callTool("actions_list", { machineId: MACHINE, threadId, limit: 50 })).body.actions as Array<Body>;
  // The lead may ask from its shell or with its ask tool; either way the hub refuses a naming question.
  const naming = actions.find((a) => /--class naming|api\.health\.name/u.test(JSON.stringify(a)) && JSON.stringify(a).includes("decide this yourself"));
  check(naming, `the naming ask was refused: ${JSON.stringify(actions.filter((a) => /naming|api\.health\.name/u.test(JSON.stringify(a))))}`);
  ok(`the naming ask was refused: "${/[^"\\]*decide this yourself[^"\\.]*/u.exec(JSON.stringify(naming))?.[0]?.trim()}"`);
  ok(`M3 loop used ${turns} lead turns (${MODEL}, effort low)`);
}
