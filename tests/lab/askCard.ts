// The question card from a real lead: a haiku lead is told only what to decide, not how to ask, and its own
// `fleetd ask` must carry labelled options with consequences, a recommendation among them and its reason. The human
// picks the second option; the answer is held for the 10 s undo window, then becomes a decision, reaches the lead,
// and ask.delivered is the receipt. Three lead turns: start, the ask, the answer wake.
import { randomUUID } from "node:crypto";
import { type Body, type Lab, MODEL } from "./harness.ts";

const MACHINE = "lab-a";
const TURN_MS = 240_000;
// Not the prompt's own example (share.link), so the labels are the lead's, not copied.
const KEY = "digest.day";
const NEED =
  "Lab check of fleetd's ask path. The human must decide when the weekly usage digest email goes out: Monday morning or Friday afternoon. You lean to Monday. Ask the human once with `fleetd ask` (key digest.day, class product), following your instructions for asks, then stop. Do not start any task.";

export async function askCard(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  const projectId = (await callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === MACHINE)?.projectId as string;
  const ref = { machineId: MACHINE, projectId };

  const turnDone = async (threadId: string, cursor: number, what: string) => {
    const { event } = await lab.waitEvent(`lead turn: ${what}`, TURN_MS, {
      cursor,
      machineId: MACHINE,
      match: (e) => e.threadId === threadId && ["thread.completed", "thread.failed", "thread.interrupted"].includes(e.type),
    });
    check(event.type === "thread.completed", `lead turn (${what}) ended with ${event.type}: ${event.summary}`);
    return event.seq as number;
  };

  let cursor = await lab.cursor();
  const started = await callTool("lead_start", { ...ref, model: MODEL, effort: "low" });
  check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
  const threadId = started.body.threadId as string;
  cursor = await turnDone(threadId, cursor, "start");
  ok(`lead ${threadId} started (${MODEL}, low)`);

  const sent = await callTool("thread_send", { machineId: MACHINE, threadId, message: NEED, clientRequestId: randomUUID() });
  check(!sent.isError, `thread_send: ${JSON.stringify(sent.body)}`);
  const askedFrom = cursor;
  cursor = await turnDone(threadId, cursor, "ask");
  await lab.waitEvent("batch.ready", 120_000, { cursor: askedFrom, types: ["batch.ready"] });
  const ask = ((await callTool("asks_list")).body.asks as Array<Body>).find((a) => a.key === KEY);
  check(ask !== undefined, `the lead filed ${KEY}`);
  const options = (ask!.options ?? []) as Array<Body>;
  check(
    options.length >= 2 && options.every((o) => typeof o.label === "string" && typeof o.consequence === "string"),
    `every option has a label and a consequence: ${JSON.stringify(ask)}`,
  );
  check(options[0]?.key === ask!.recommendation && typeof ask!.recommendationWhy === "string", `the recommendation is option a, with a reason: ${JSON.stringify(ask)}`);
  ok(`the lead's own ask: "${ask!.text}" | ${options.map((o) => `${o.label} (${o.consequence})`).join(" | ")} | rec ${ask!.recommendation}: ${ask!.recommendationWhy}`);
  const actions = (await callTool("actions_list", { machineId: MACHINE, threadId, limit: 50 })).body.actions as Array<Body>;
  const refused = actions.filter((a) => a.kind === "command" && a.summary.includes("fleetd ask") && a.outputTail?.includes("could not tell"));
  ok(`fleetd ask calls the hub refused first: ${refused.length}`);

  const replied = (await callTool("inbox_reply", { raw: `${ask!.number} b` })).body;
  const applied = replied.applied?.[0] as Body | undefined;
  check(replied.parsed && applied?.undoUntil && applied.decisionId === undefined, `held for the undo window: ${JSON.stringify(replied)}`);
  ok(`inbox_reply "${ask!.number} b": ${replied.echo}`);
  const delivered = await lab.waitEvent("ask.delivered", 60_000, { cursor, types: ["ask.delivered"], match: (e) => e.data?.askId === ask!.askId });
  const decision = (await callTool("decisions_search", { query: KEY })).body.decisions[0];
  check(decision?.value === options[1]?.key, `the decision is option b's key: ${JSON.stringify(decision)}`);
  ok(`ask.delivered ${delivered.event.data.deliveredAt}, decision ${decision.decisionId} = ${decision.value}`);
  const wake = await lab.waitEvent("lead.woken with the answer", 60_000, {
    cursor,
    machineId: MACHINE,
    types: ["lead.woken"],
    match: (e) => (e.data?.triggers ?? []).includes("answer"),
  });
  await turnDone(threadId, wake.event.seq, "answer wake");
  const tail = (await callTool("thread_tail", { machineId: MACHINE, threadId, n: 20, kinds: ["message"] })).body.items as Array<Body>;
  const line = tail.find((i) => i.role === "user" && i.text.includes(`${KEY} → ${options[1]?.key}`));
  check(line !== undefined, `the wake names the pick: ${JSON.stringify(tail).slice(0, 800)}`);
  ok(`the answer wake carried: ${line!.text.split("\n").find((l: string) => l.includes(`${KEY} →`))?.trim()}`);
}
