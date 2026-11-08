// A lead is woken, and its next turn sees why: a writer asks its lead with ask_lead (fleetd's own agent tool, called
// from the writer's session as claude would), the hub wakes the project's running lead with the question, and the
// lead's next turn is given it. The lead answers with message_agent, and the writer's next turn is given the answer.
// Both wakes go through the hub's write queue to the node, so a send that never reaches the node (the Bun executor's
// missing sendWith, #1278) fails here, where nothing else in the lab woke a lead.
import { check, ok, sleep } from "../harness.ts";
import type { Factory } from "./kit.ts";

const ENDS = ["thread.completed", "thread.failed", "thread.interrupted"];

export async function leadWake(f: Factory) {
  // The lead runs, and its first turn is over: what comes next is a wake.
  const from = await f.cursor();
  const started = await f.callTool("lead_start", f.ref);
  check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
  const lead = started.body.threadId as string;
  await f.waitEvent("the lead's first turn ends", 120_000, { cursor: from, types: ENDS, match: (e) => e.threadId === lead });
  const leadTurns = f.messages(lead).length;

  // The writer asks from its own session: agent-mcp names it by the session its shell runs in.
  const question = "Which shelf holds the pears? (lab-question)";
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_lead", arguments: { question } } };
  const w = f.workstream("Shelf check.");
  const spawned = f.spawnWriter(w, "shelf check", `Check the shelves; ask your lead where the pears go.\nlab-run: printf '%s\\n' '${JSON.stringify(call)}' | fleetd agent-mcp --role worker`);
  const taskId = spawned.taskId as string;
  const asked = await f.waitTask(taskId, ["idle", "done"]);
  const writer = asked.threadRef.threadId as string;
  check(f.messages(writer).length === 1, `${taskId} ran one turn, its brief: ${JSON.stringify(f.messages(writer))}`);

  // The lead's next turn is given the question.
  const woke = await f.until(`the lead is woken with ${taskId}'s question`, 60_000, async () => {
    const turn = f.messages(lead).slice(leadTurns).find((m) => m.includes(question));
    return turn ?? (await sleep(250), undefined);
  });
  check(woke.includes(taskId), `the lead's wake names ${taskId}:\n${woke}`);
  ok(`${taskId}'s ask_lead woke the lead; its next turn began: "${woke.split("\n")[0]!.slice(0, 90)}…"`);

  // The lead answers, and the writer's next turn is given the answer.
  const answer = "Top shelf, left of the apples. (lab-answer)";
  const sent = f.lead("message_agent", { taskId, message: answer });
  check(sent.code === 0, `message_agent ${taskId}: ${sent.text}`);
  const heard = await f.until(`${taskId} is given the lead's answer`, 60_000, async () => {
    const turn = f.messages(writer).slice(1).find((m) => m.includes(answer));
    return turn ?? (await sleep(250), undefined);
  });
  ok(`the lead's message_agent answered ${taskId}; its next turn began: "${heard.split("\n")[0]!.slice(0, 90)}…"`);
}
