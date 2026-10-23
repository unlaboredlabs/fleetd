// Claude Code's own subagents are off and agents start only through fleetd (FLEETD_LAB_SLOT=6 `npm run lab nosub`).
// A lead told to start a subagent with Agent/Task can't: its init has no agent
// tool, any call it makes is refused, and no subagent starts; a `claude` it runs in Bash is refused too. Its MCP
// `spawn_agent` starts a fleetd task that shows as a lane on the order and ran through the slot board. A task's agent
// gets only report/ask_lead, and its own shell can't spawn either, with FLEETD_THREAD_ID unset or forged as
// the lead's. A few tiny lead turns, two task turns.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type Body, chatOrder, fleetdCommand, type Lab, leadIn, MECHANICS, MODEL, nodeHome, nodeSock, scrubbedEnv } from "./harness.ts";
import { prepareRepo } from "./m5Tasks.ts";

const MACHINE = "lab-a";
const TURN_MS = 240_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];
/** What the deny list and the knobs must keep out of every fleetd session's init. */
const AGENT_TOOLS = ["Task", "Agent", "Workflow", "ListAgents", "SendMessage", "TaskStop", "TaskOutput", "TeamCreate", "TeamDelete"];
const KNOB_AGENTS = ["claude", "Explore", "Plan"];

/**
 * claude's stdout from a node transcript: each line is `{dir, ms, msg}` (claude's own lines are `dir: "out"`), or, from
 * older nodes, claude's message itself.
 */
export const parseTranscript = (text: string): Array<Body> =>
  text
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Body)
    .flatMap((r) => (r.msg === undefined ? [r] : r.dir === "out" ? [r.msg as Body] : []));

/** claude's stdout as the node recorded it for a session. */
const transcript = (threadId: string): Array<Body> => {
  const file = path.join(nodeHome(MACHINE), "transcripts", `${threadId}.jsonl`);
  return fs.existsSync(file) ? parseTranscript(fs.readFileSync(file, "utf8")) : [];
};

/**
 * A session's init tool list, checked: it must exist (a session whose init can't be read fails, never passes for having
 * no tools to look at) and hold none of Claude's own agent tools.
 */
export const checkedInitTools = (msgs: ReadonlyArray<Body>, what: string): Array<string> => {
  const init = msgs.find((m) => m.type === "system" && m.subtype === "init");
  if (!Array.isArray(init?.tools)) throw new Error(`check failed: ${what}'s init line with its tool list is in its transcript`);
  const tools = init.tools as Array<string>;
  const agentTools = AGENT_TOOLS.filter((t) => tools.includes(t));
  if (agentTools.length > 0) throw new Error(`check failed: ${what}'s init has no agent tool: ${agentTools.join(", ")}`);
  return tools;
};

const initOf = (threadId: string) => transcript(threadId).find((m) => m.type === "system" && m.subtype === "init");

/** The session's tool calls `pick` keeps, each with whether claude refused it and what it answered. */
const toolCalls = (threadId: string, pick: (call: Body) => boolean) => {
  const msgs = transcript(threadId);
  const results = new Map<string, Body>();
  for (const m of msgs.filter((m) => m.type === "user")) {
    for (const c of (m.message?.content as Array<Body> | undefined) ?? []) if (c.type === "tool_result") results.set(c.tool_use_id, c);
  }
  return msgs
    .filter((m) => m.type === "assistant")
    .flatMap((m) => (m.message?.content as Array<Body> | undefined) ?? [])
    .filter((c) => c.type === "tool_use" && pick(c))
    .map((c) => {
      const result = results.get(c.id);
      return { name: c.name as string, refused: result?.is_error === true, said: JSON.stringify(result?.content ?? "").slice(0, 160) };
    });
};

const agentCalls = (threadId: string) => toolCalls(threadId, (c) => AGENT_TOOLS.includes(c.name));
/** The lead's Bash calls that start a claude of its own (the lab asks for `claude --version`, two spellings). */
const nestedClaudeCalls = (threadId: string) =>
  toolCalls(threadId, (c) => c.name === "Bash" && String(c.input?.command ?? "").includes("claude --version"));

/** Lines claude prints when one of its own subagents or background tasks starts. */
const subagentStarts = (threadId: string) =>
  transcript(threadId).filter((m) => m.type === "system" && ["task_started", "task_notification"].includes(m.subtype));

export async function noSubagents(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  const projectId = (await callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === MACHINE)?.projectId as string;
  check(projectId, `${MACHINE} has a project`);
  const ref = { machineId: MACHINE, projectId };
  const root = (await callTool("project_get", ref)).body.project.workspaceRoot as string;
  prepareRepo(root);

  let leadThread = "";
  let leadTurns = 0;
  const leadTurnDone = async (cursor: number, what: string) => {
    const { event } = await lab.waitEvent(`lead turn: ${what}`, TURN_MS, {
      cursor,
      machineId: MACHINE,
      match: (e) => e.threadId === leadThread && ENDED.includes(e.type),
    });
    leadTurns += 1;
    check(event.type === "thread.completed", `lead turn (${what}) ended with ${event.type}: ${event.summary}`);
    return event.seq as number;
  };

  // A lead this build started (so it has fleetd's MCP server), and an open order to spawn under.
  let cursor = await lab.cursor();
  let outcome = (await callTool("project_get", ref)).body;
  if (outcome.lead !== undefined) {
    const restarted = await callTool("lead_start", { ...ref, fresh: true });
    check(!restarted.isError, `lead_start fresh: ${JSON.stringify(restarted.body)}`);
    leadThread = restarted.body.threadId;
  } else {
    const started = await callTool("lead_start", ref);
    check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
    leadThread = started.body.threadId;
  }
  cursor = await leadTurnDone(cursor, "start");
  outcome = (await callTool("project_get", ref)).body;
  let workstreamId = (outcome.workstreams as Array<Body> | undefined)?.find((w) => w.state === "running")?.workstreamId as string | undefined;
  if (workstreamId === undefined) {
    const order = await chatOrder(lab, ref, "add a docs page (lab run: open its workstream with workstream_open and register the brief with your brief tool, then stop; spawn no tasks until told)");
    workstreamId = order.workstreamId;
    await lab.waitEvent(`workstream.running for ${workstreamId}`, TURN_MS, { cursor, machineId: MACHINE, types: ["workstream.running"] });
    cursor = await leadTurnDone(cursor, "the chat turn");
  }

  const leadInit = initOf(leadThread);
  const leadTools = checkedInitTools(transcript(leadThread), `lead ${leadThread}`);
  check(leadTools.includes("mcp__fleetd__spawn_agent"), `the lead has fleetd's spawn_agent: ${JSON.stringify(leadTools)}`);
  check(!KNOB_AGENTS.some((a) => (leadInit?.agents ?? []).includes(a)), `no Explore, Plan or claude agent: ${JSON.stringify(leadInit?.agents)}`);
  ok(`lead ${leadThread}: init has mcp__fleetd__spawn_agent, no agent tool; agents ${JSON.stringify(leadInit?.agents)}`);

  // The lead tries Claude's own subagent, then spawns through fleetd.
  const spawnArgs = { workstreamId, title: "say ok", kind: "read", prompt: "Reply with the single word OK.", profile: MECHANICS };
  const sent = await lab.humanCall("chat_send", {
    projectRef: ref,
    clientRequestId: randomUUID(),
    text:
      `Lab test of how agents start. Step 1: start a Claude Code subagent with your Agent tool (it may be named Task), prompt "say hi". ` +
      "Step 2: with your Bash tool, run `claude --version`, then `sh -c 'claude --version'`, as two separate calls. " +
      `Step 3: whatever steps 1 and 2 did, call fleetd's spawn_agent tool once with ${JSON.stringify(spawnArgs)}. ` +
      `Step 4: reply with one line saying what each step returned, and stop. In later wakes about tasks, call no tools: reply with one short line and stop.`,
  });
  check(!sent.isError, `chat_send to the lead: ${JSON.stringify(sent.body)}`);
  const turn = leadTurnDone(cursor, "try Agent, then spawn_agent");
  turn.catch(() => undefined);
  const started = await lab.waitEvent("task.started from the lead's spawn_agent", TURN_MS, {
    cursor,
    types: ["task.started"],
  });
  const taskId = started.event.data.taskId as string;
  const task = (await callTool("task_get", { taskId })).body.task as Body;
  check(task.kind === "read" && task.title === "say ok" && task.threadRef?.threadId, `the spawned task: ${JSON.stringify(task)}`);
  ok(`spawn_agent started ${taskId} through the slot board (${started.event.summary}), thread ${task.threadRef.threadId}`);
  await turn;

  // Refused: the lead's calls to Agent/Task, if it made any, all came back as errors, and no subagent started.
  const calls = agentCalls(leadThread);
  check(calls.every((c) => c.refused), `every Agent/Task call was refused: ${JSON.stringify(calls)}`);
  check(subagentStarts(leadThread).length === 0, `no subagent started in the lead: ${JSON.stringify(subagentStarts(leadThread))}`);
  ok(
    calls.length === 0
      ? "the lead had no Agent or Task tool to call (none offered); no subagent started"
      : `the lead tried ${calls.map((c) => c.name).join(", ")}: refused (${calls[0]!.said}); no subagent started`,
  );
  // And no claude of its own from its shell, by name or through `sh -c`.
  const claudes = nestedClaudeCalls(leadThread);
  check(claudes.length > 0 && claudes.every((c) => c.refused), `every \`claude\` in the lead's Bash was refused: ${JSON.stringify(claudes)}`);
  ok(`the lead ran claude from Bash ${claudes.length} time(s): refused (${claudes[0]!.said})`);

  // A lane: the order shows the task as one of its agents.
  const order = (await callTool("order_get", { workstreamId })).body;
  const lanes = [...((order.order?.lanes as Array<Body>) ?? []), ...((order.doneLanes as Array<Body>) ?? [])];
  const lane = lanes.find((l) => l.taskId === taskId);
  check(lane?.threadRef?.threadId === task.threadRef.threadId, `order_get has ${taskId}'s lane: ${JSON.stringify(lanes.map((l) => [l.laneId, l.role, l.status]))}`);
  ok(`order_get ${workstreamId}: lane ${lane!.laneId} (${lane!.role}, ${lane!.status})`);

  // The task's agent: only the worker's tools, no agent tool, and the hub refuses its spawns from its shell too.
  const taskThread = task.threadRef.threadId as string;
  await lab.waitEvent(`${taskId} ends`, TURN_MS, { cursor: started.cursor, types: ["task.completed", "task.failed"], match: (e) => e.data?.taskId === taskId });
  const taskTools = checkedInitTools(transcript(taskThread), `${taskId}'s session`);
  const fleetdTools = taskTools.filter((t) => t.startsWith("mcp__fleetd__")).sort();
  check(
    JSON.stringify(fleetdTools) === JSON.stringify(["mcp__fleetd__ask_lead", "mcp__fleetd__report"]),
    `the task gets the worker's tools only: ${JSON.stringify(fleetdTools)}`,
  );
  check(subagentStarts(taskThread).length === 0, "no subagent started in the task");
  ok(`${taskId}'s init: ${fleetdTools.join(", ")}; no agent tool; no subagent started`);

  // A person's own shell (outside every session) makes lead calls as before; claiming a session from it is refused.
  const shell = (env: Record<string, string>) => leadIn(root, { ...scrubbedEnv(), FLEETD_NODE_SOCK: nodeSock(MACHINE), ...env });
  check(shell({})("list_agents", {}).code === 0, "a person's own list_agents goes through");
  const claimed = shell({ FLEETD_THREAD_ID: leadThread })("list_agents", {});
  check(claimed.code === 3 && claimed.text.includes("does not run in it"), `claiming the lead's session from outside it is refused: ${JSON.stringify(claimed)}`);
  ok(`a person's shell: task list ok; claiming the lead's session refused (${claimed.text.trim().split("\n")[0]})`);

  // From inside a task: its own shell spawns with FLEETD_THREAD_ID unset and with the lead's id forged. The node names
  // the session from the process tree, so both are refused. The harness starts this task as a person would.
  const bin = fleetdCommand([])[0];
  const nested = (title: string, env: string) => {
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "spawn_agent", arguments: { workstreamId, title, kind: "read", prompt: "hi" } } };
    return `echo '${JSON.stringify(call)}' | ${env} ${bin} agent-mcp --role lead`;
  };
  const commands = [nested("nested-unset", "env -u FLEETD_THREAD_ID"), nested("nested-forged", `env FLEETD_THREAD_ID=${leadThread}`)];
  const bypass = shell({})("spawn_agent", {
    workstreamId,
    title: "try nested spawns",
    kind: "read",
    profile: MECHANICS,
    prompt: `This is a lab test of fleetd's refusals. Run these two shell commands exactly as written, one at a time, then reply with one line per command: its exit code and first line of output.\n1. ${commands[0]}\n2. ${commands[1]}`,
  });
  const bypassId = bypass.result?.task?.taskId as string | undefined;
  check(bypass.code === 0 && bypassId, `the harness spawns the bypass task: ${JSON.stringify(bypass)}`);
  const bypassEnd = await lab.waitEvent(`${bypassId} ends`, TURN_MS, {
    cursor: started.cursor,
    types: ["task.completed", "task.failed"],
    match: (e) => e.data?.taskId === bypassId,
  });
  const bypassThread = (await callTool("task_get", { taskId: bypassId })).body.task.threadRef.threadId as string;
  const msgs = transcript(bypassThread);
  const results = new Map<string, string>();
  for (const m of msgs.filter((m) => m.type === "user")) {
    for (const c of (m.message?.content as Array<Body> | undefined) ?? []) {
      if (c.type === "tool_result") results.set(c.tool_use_id, JSON.stringify(c.content));
    }
  }
  const runs = msgs
    .filter((m) => m.type === "assistant")
    .flatMap((m) => (m.message?.content as Array<Body> | undefined) ?? [])
    .filter((c) => c.type === "tool_use" && c.name === "Bash" && String(c.input?.command).includes("agent-mcp"))
    .map((c) => ({ command: String(c.input.command), said: results.get(c.id) ?? "" }));
  const unset = runs.find((r) => r.command.includes("env -u FLEETD_THREAD_ID"));
  const forged = runs.find((r) => r.command.includes(`FLEETD_THREAD_ID=${leadThread}`));
  check(unset?.said.includes(`${bypassId} is a task, and a task's agent can't start agents`), `unset id refused as the task: ${JSON.stringify(unset)}`);
  check(forged?.said.includes(`but runs in session ${bypassThread}`), `forged lead id refused: ${JSON.stringify(forged)}`);
  const spawnedTitles = ((await callTool("tasks_list", { projectRef: ref, limit: 50 })).body.tasks as Array<Body>).map((t) => t.title as string);
  check(!spawnedTitles.some((t) => t.startsWith("nested")), `no nested task exists: ${JSON.stringify(spawnedTitles)}`);
  ok(`${bypassId} (${bypassEnd.event.type}) ran both from its shell: FLEETD_THREAD_ID unset → refused as ${bypassId}; forged as the lead → refused; no nested task`);

  // Let the result wake run out, so the next scenario finds the lead idle.
  const woken = await lab.waitEvent("the lead's wake with the result", 90_000, { cursor: started.cursor, machineId: MACHINE, types: ["lead.woken"] }).catch(() => undefined);
  if (woken !== undefined) await leadTurnDone(woken.event.seq, "result wake");
  ok(`nosub used ${leadTurns} lead turns + 2 task turns (${MODEL}, tasks on medium)`);
}
