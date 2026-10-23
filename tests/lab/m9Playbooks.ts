// M9 playbooks on lab-a: (a) a workstream opened with the bugfix playbook pins it; (b) a research brief without its
// baseline and decision rule is refused, then set with them. The harness's own tool calls run in the project's
// workspace and cost no turns.
import path from "node:path";
import { type Body, MODEL, openWorkstream, type Lab, leadIn, nodeSock, requireGhLogin, scrubbedEnv } from "./harness.ts";
import { CLONE } from "./m7Train.ts";

const MACHINE = "lab-a";
const TURN_MS = 240_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];

export async function m9Playbooks(lab: Lab) {
  const { callTool, check, ok } = lab;
  await lab.waitLive(MACHINE);
  requireGhLogin();
  const projectId = (await callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === MACHINE && p.workspaceRoot !== CLONE)?.projectId as string;
  check(projectId, `${MACHINE} has a project`);
  const ref = { machineId: MACHINE, projectId };
  const outcome = (await callTool("project_get", ref)).body;
  const root = outcome.project.workspaceRoot as string;
  const lead = leadIn(root, { ...scrubbedEnv(), FLEETD_NODE_SOCK: nodeSock(MACHINE) });
  const scenarioStart = await lab.cursor();
  const leadTurnEnds = (thread: string, cursor: number) =>
    lab.waitEvent("a lead turn to end", TURN_MS, { cursor, match: (e) => e.threadId === thread && ENDED.includes(e.type) });

  // The lead: an earlier scenario's, else a fresh one.
  let leadThread: string;
  if (outcome.lead === undefined) {
    const started = await callTool("lead_start", ref);
    check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
    leadThread = started.body.threadId;
    await leadTurnEnds(leadThread, scenarioStart);
  } else {
    leadThread = outcome.lead.threadId;
  }
  const leads = [leadThread];

  // (a) A fix opened with the bugfix playbook, with the lead's tool.
  const wa = openWorkstream(check, lead, "fix: the repo-a README has a typo.", "bugfix");
  const pinnedA = (await callTool("workstream_get", { workstreamId: wa })).body.workstream.playbook as string;
  check(/^bugfix@[0-9a-f]{40}$/u.test(pinnedA), `${wa} pins bugfix: ${pinnedA}`);
  ok(`(a) ${wa} in ${MACHINE}/${projectId}; playbook ${pinnedA.slice(0, 19)}…`);

  // (b) A research workstream: the brief pre-registers baseline, metric and rule.
  const briefBase = { pointers: [], constraints: [] };
  const wr = openWorkstream(check, lead, "research: would a shorter README read faster?", "research");
  const pinnedR = (await callTool("workstream_get", { workstreamId: wr })).body.workstream.playbook as string;
  check(/^research@[0-9a-f]{40}$/u.test(pinnedR), `${wr} pins research: ${pinnedR}`);
  const research = {
    ...briefBase,
    goal: "find out whether a shorter README reads faster",
    why: "M9 lab",
    doneWhen: ["both numbers are measured"],
    baseline: "the README as it is",
    metric: "seconds to read the README",
    decisionRule: { better: "lower", goAtLeast: 5, stopBelow: 5 },
    budget: { size: "S" },
  };
  const { baseline: _b, decisionRule: _r, ...unregistered } = research;
  const missing = lead("brief", { workstreamId: wr, brief: unregistered });
  check(missing.code === 3 && missing.text.includes("missing baseline, decisionRule"), `research brief without baseline and rule: ${JSON.stringify(missing)}`);
  const frozen = lead("brief", { workstreamId: wr, brief: research });
  check(frozen.code === 0, `research brief: ${JSON.stringify(frozen)}`);
  ok(`(b) ${wr} research: a brief without baseline and decisionRule refused (${missing.text.split("\n")[0]}); then frozen with rule lower-is-better, GO at 5 s`);

  // Let the last lead wakes on lab-a run out, then count every claude turn this scenario cost.
  for (let after = await lab.cursor(); ; ) {
    const wake = await lab.waitEvent("a late lead wake", 30_000, { cursor: after, machineId: MACHINE, types: ["lead.woken"], match: (e) => e.threadId === leadThread }).catch(() => undefined);
    if (wake === undefined) break;
    after = (await leadTurnEnds(leadThread, wake.event.seq)).cursor;
  }
  let leadTurns = 0;
  for (let at = scenarioStart; ; ) {
    const page = (await callTool("events_wait", { cursor: at, machineId: MACHINE, types: ENDED, timeoutSec: 0 })).body;
    leadTurns += (page.events as Array<Body>).filter((e) => leads.includes(e.threadId)).length;
    if (!page.more) break;
    at = page.cursor;
  }
  const ours = [wa, wr];
  const tasks = ((await callTool("tasks_list", { projectRef: ref, limit: 100 })).body.tasks as Array<Body>).filter((t) => ours.includes(t.workstreamId));
  const taskTurns = tasks.reduce((n, t) => n + (t.attempt as number), 0);
  const total = leadTurns + taskTurns;
  ok(`M9 used ${leadTurns} lead turns + ${taskTurns} task turns (${tasks.map((t) => `${t.taskId} ${t.kind}×${t.attempt}`).join(", ")}) = ${total} claude turns (${MODEL})`);
  check(total <= 10, `M9 stays within 10 claude turns (${total})`);
}
