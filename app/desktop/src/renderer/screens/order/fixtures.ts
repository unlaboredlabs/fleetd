// The order view's fixture data, as the hub's call outputs (order_get, workstream_get, thread_tail, steers_list,
// session_prompt_get, prompts_list) so a fixture transport can replay them: a conversation with a wake, markdown
// replies, a lead → task message, a person → task steer and a long streaming message; the told panel with all
// defaults and with project overrides; long titles and criteria; 20+ agents; and a 20k-item log for the scroll
// budget. No personal data: acme/storefront on devbox and buildbox.

import type { AgentLane, CheckSpec, Claim, LiveText, PromptSummary, SessionPrompt, Steer, TailItem } from "../../../shared/contracts";

export type OrderFixture = "typical" | "conversation" | "long-text" | "many-agents" | "empty" | "huge-log" | "huge-stream";

const T = (m: number, s = 0) => new Date(Date.UTC(2026, 9, 19, 8, m, s)).toISOString();
const PROJECT = { machineId: "devbox", projectId: "p-storefront" };
const LEAD_THREAD = { machineId: "devbox", threadId: "thread-lead-storefront" };

const lane = (n: number, role: AgentLane["role"], status: AgentLane["status"], title: string, extra: Partial<AgentLane> = {}): AgentLane => ({
  laneId: `T${n}`,
  role,
  taskId: `T${n}`,
  threadRef: { machineId: n % 2 ? "devbox" : "buildbox", threadId: `thread-t${n}` },
  title,
  model: "claude-opus-5-5",
  effort: "high",
  status,
  startedAt: T(2),
  branch: `fleetd/T${n}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
  ...extra,
});

const leadLane = (status: AgentLane["status"]): AgentLane => ({
  laneId: "lead-storefront",
  role: "lead",
  threadRef: LEAD_THREAD,
  title: "lead",
  model: "claude-opus-5-5",
  status,
  live:
    status === "working"
      ? { laneId: "lead-storefront", status, activity: { activity: { kind: "command", text: "pnpm test --filter console" }, since: T(16) } }
      : { laneId: "lead-storefront", status },
});

const WAKE = [
  "# fleetd digest: project storefront (devbox/p-storefront), 08:15",
  "This is the current truth about your project. Trust it over your memory.",
  "",
  "## Decisions",
  "- D3 share.after_first = the second writer starts after the first PR merges (project, lead)",
  "- D2 share.render = browser-side PNG render, the server only stores uploaded snapshots (project, lead)",
  "",
  "## Do not re-ask: keys already decided or asked",
  "share.public_link, share.window, share.render",
  "",
  "## Why you are woken",
  "- The human settled 2 of your asks; see \"Answers since your last wake\" above.",
].join("\n");

const LEAD_REPLY = [
  "Both answers are in. Here is the plan for **W1**:",
  "",
  "1. T1 keeps the public snapshot route at `/console/share/<id>.png`.",
  "2. The headline stays literal: *$200/mo plan → $1,840 of usage this week*.",
  "",
  "```ts",
  "export const shareWindowDays = 7;",
  "```",
  "",
  "I'll check T1's PR once CI is green.",
].join("\n");

const STREAMING =
  "You approved both of my questions, so T1 can finish the share card without waiting. I'm now checking that the snapshot route caches correctly: the first request renders the PNG in the browser, uploads it, and every later request is served from storage. " +
  "If the cache misses, the route answers 404 rather than rendering on the server, which keeps the server free of a headless browser.";

function tail(fixture: OrderFixture): TailItem[] {
  if (fixture === "empty") return [];
  if (fixture === "huge-log") return hugeLog(20_000);
  if (fixture === "huge-stream") return [];
  const items: TailItem[] = [
    { kind: "message", at: T(1), role: "user", text: "You are the lead of project storefront (devbox/p-storefront) in fleetd.\n\nHow you work:\n- You never write code yourself." },
    { kind: "message", at: T(3), role: "assistant", text: "Froze the brief for **W1**: two checks, tier M. Starting T1 as the writer." },
    { kind: "action", at: T(3, 10), action: { at: T(3, 10), kind: "command", status: "completed", summary: "fleetd task spawn --workstream W1 --role implementer", failed: false } },
    { kind: "action", at: T(3, 40), action: { at: T(3, 40), kind: "command", status: "failed", summary: "gh pr checks 211", failed: true } },
    { kind: "message", at: T(12), role: "assistant", text: "W2 is waiting on W1's PR; nothing to do there yet." },
    { kind: "message", at: T(15), role: "user", text: WAKE },
    { kind: "message", at: T(15, 20), role: "assistant", text: LEAD_REPLY },
    { kind: "message", at: T(16), role: "user", text: "S1 · the human steers you (W1): 'keep the headline literal'\nBegin your next message with \"S1:\"…" },
    { kind: "message", at: T(16, 5), role: "assistant", text: "S1: keeping the headline literal; no prorated variant." },
  ];
  if (fixture === "long-text") {
    items.push({
      kind: "message",
      at: T(17),
      role: "assistant",
      text: `A very long reply that must wrap rather than clip: ${"supercalifragilistic-path/segment/".repeat(12)} and a table:\n\n| check | state |\n|---|---|\n| PR merged | passed |\n| judge | pending |`,
    });
  }
  return items;
}

function hugeLog(n: number): TailItem[] {
  const out: TailItem[] = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.UTC(2026, 9, 19, 0, 0, 0) + i * 1000).toISOString();
    if (i % 3 === 0) out.push({ kind: "message", at, role: "assistant", text: i % 9 === 0 ? `Step ${i}: ran **pnpm test**, \`${i}\` passed.\n\n- one\n- two` : `Line ${i} of the lead's log, plain words that wrap when the pane is narrow.` });
    else out.push({ kind: "action", at, action: { at, kind: "command", status: "completed", summary: `pnpm test --shard ${i}`, failed: false } });
  }
  return out;
}

/** 20k lines streamed by the lead, a new message every 400 lines (the shape of E3b's conversation-20k). */
function streamedLines(n: number): LiveText[] {
  const runs = ["ok   storefront-checkout > formats receipt dates for en-GB", "run  pnpm --filter storefront build", "edit src/checkout/receipt/formatReceiptDate.ts"];
  const out: LiveText[] = [];
  for (let line = 1; line <= n; line++) {
    const text = line % 25 === 0 ? `## Step ${line / 25}` : `${line}  ${runs[line % runs.length] ?? ""}`;
    out.push({ laneId: "lead-storefront", messageId: `stream-${Math.floor(line / 400)}`, append: `${text}\n` });
  }
  return out;
}

function steers(fixture: OrderFixture): Steer[] {
  if (fixture === "empty" || fixture === "huge-log") return [];
  const base = { workstreamId: "W1", mode: "queue" as const };
  return [
    {
      ...base,
      id: "S1",
      target: { workstreamId: "W1" },
      thread: LEAD_THREAD,
      runId: "run-s1",
      by: { kind: "human", keyName: "your console" },
      text: "Keep the headline **literal**: no prorated variant.",
      stage: "acknowledged",
      queuedAt: T(15, 55),
      deliveredAt: T(16),
      how: "turn",
      ackedAt: T(16, 5),
      ackExcerpt: "S1: keeping the headline literal; no prorated variant.",
    },
    {
      ...base,
      id: "S2",
      target: { taskId: "T1" },
      thread: { machineId: "devbox", threadId: "thread-t1" },
      runId: "run-s2",
      by: { kind: "lead" },
      text: "Both pending asks are settled: the public snapshot link at `/console/share/<id>.png` is approved (D5), and the headline stays literal (D4). Drop the prorated variant.",
      stage: "acknowledged",
      queuedAt: T(15, 30),
      deliveredAt: T(15, 31),
      how: "boundary",
      ackedAt: T(15, 40),
      ackExcerpt: "S2: keeping the literal headline and the public snapshot route.",
    },
    {
      ...base,
      id: "S3",
      target: { taskId: "T1" },
      thread: { machineId: "devbox", threadId: "thread-t1" },
      runId: "run-s3",
      by: { kind: "human", keyName: "your console" },
      mode: "now",
      text: "Use the brand green for the card's border.",
      stage: "unacknowledged",
      queuedAt: T(16, 30),
      deliveredAt: T(16, 31),
      how: "stopped",
      stoppedTool: "pnpm build",
      ackExcerpt: "Continuing with the layout.",
    },
    {
      ...base,
      id: "S4",
      target: { workstreamId: "W1" },
      thread: LEAD_THREAD,
      runId: "run-s4",
      by: { kind: "human", keyName: "your console" },
      text: "After T1, ask me before starting W2.",
      stage: "queued",
      queuedAt: T(17),
    },
  ];
}

const CRITERIA =
  "On the merged main branch the console has a share card showing last-7-days tokens, the API-price value against the entered monthly plan, a Copy image button that produces a PNG, and a public snapshot link that serves the same PNG without a login.";

function lanes(fixture: OrderFixture): AgentLane[] {
  if (fixture === "empty") return [];
  const base = [
    lane(1, "implementer", "working", "Share card with copy image and snapshot", {
      live: { laneId: "T1", status: "working", activity: { activity: { kind: "edit", path: "apps/console/src/share/ShareCard.tsx" }, since: T(16) } },
      pr: { changeId: "C1", repo: "acme/storefront", number: 211, url: "https://github.com/acme/storefront/pull/211", state: "reviewing", reviewsDone: 1, reviewsNeeded: 2, taskId: "T1" },
    }),
    lane(2, "reviewer", "queued", "Review #211", { statusReason: "slots: 4/4 in use" }),
    lane(3, "verifier", "done", "Verify the snapshot route", { endedAt: T(14) }),
  ];
  if (fixture === "long-text") base[0] = { ...base[0], title: "A share card on the console: tokens in the last 7 days, the API-price value against the monthly plan, and a public snapshot link" } as AgentLane;
  if (fixture !== "many-agents") return base;
  const more: AgentLane[] = [];
  for (let n = 4; n < 26; n++) {
    const status = (["working", "queued", "done", "failed", "waiting", "parked"] as const)[n % 6] ?? "working";
    more.push(lane(n, n % 4 === 0 ? "reviewer" : "implementer", status, `Part ${n} of the share card`, status === "failed" ? { statusReason: "pnpm test exited 1" } : {}));
  }
  return [...base, ...more];
}

const CHECKS: CheckSpec[] = [
  { type: "pr_merged", repo: "acme/storefront" },
  { type: "judge", criteria: CRITERIA },
  { type: "cmd", machineId: "buildbox", argv: ["pnpm", "test", "--filter", "console"], expectExit: 0 },
];

const CLAIM: Claim = {
  claimId: "C7",
  workstreamId: "W1",
  by: "lead:devbox/p-storefront",
  at: T(14),
  outcome: "fail",
  results: [
    { checkIndex: 0, spec: CHECKS[0] as CheckSpec, result: "pass", evidence: "#211 merged", ranBy: "hub", at: T(14) },
    { checkIndex: 1, spec: CHECKS[1] as CheckSpec, result: "fail", evidence: "The card shows the last 30 days, not 7, and the snapshot link asks for a login.", ranBy: "judge", at: T(14) },
  ],
};

const REGISTRY: PromptSummary[] = [
  ["lead.start", "The lead's first message", "lead"],
  ["lead.digest", "The lead's digest", "lead"],
  ["task.brief.write", "A writer's brief", "tasks"],
  ["task.brief.review", "A reviewer's brief", "tasks"],
  ["task.review_findings", "Review findings sent back to the writer", "tasks"],
  ["review.reviewer", "How a reviewer reviews", "reviews_and_checks"],
  ["review.verifier", "How a verifier checks", "reviews_and_checks"],
  ["judge", "The judge of a done-when check", "reviews_and_checks"],
  ["steer.message", "A steer, as the agent receives it", "wakes_and_messages"],
  ["wake.task_result", "Wake: a task finished", "wakes_and_messages"],
  ["wake.answers", "Wake: you answered its questions", "wakes_and_messages"],
  ["wake.agent_steer", "Wake: you steered one of its agents directly", "wakes_and_messages"],
  ["permission.denied.policy", "A tool refused by the project's policy", "wakes_and_messages"],
  ["watchdog.nudge", "A nudge to a stalled agent", "wakes_and_messages"],
  ["usage.continue", "Continue after a usage limit reset", "wakes_and_messages"],
  ["router", "Routing a new order to a project", "one_shots"],
  ["retro", "The weekly retro", "one_shots"],
  ["playbook.bugfix", "Playbook: fix a bug", "playbooks"],
  ["instructions", "Your instructions", "instructions"],
].map(([id = "", title = "", group = "lead"]) => ({
  id,
  title,
  group: group as PromptSummary["group"],
  kind: id === "instructions" ? "instructions" : id.startsWith("playbook") ? "playbook" : id === "router" || id === "retro" ? "oneshot" : id.startsWith("lead.start") || id.startsWith("task.brief") ? "start" : "wake",
  sentWhen: "",
  scope: "default",
  defaultRef: `${id}@0123456789`,
  stale: false,
}));

export function sessionPrompt(withOverrides: boolean): SessionPrompt {
  return {
    machineId: "devbox",
    threadId: "thread-t1",
    projectRef: PROJECT,
    startedAt: T(3, 12),
    text: "### Task\nBuild the **share card** on the console.\n\n- last-7-days tokens\n- a Copy image button\n\n```sh\npnpm test --filter console\n```\n\nWhen done, open a PR and stop.",
    textSha: "9f2c4b7e1a0d3c5b8e6f7a9d2c4b6e8f0a1c3e5d",
    refs: REGISTRY.filter((p) => p.group !== "one_shots" && p.group !== "playbooks").map((p) => ({
      id: p.id,
      ref: `${p.id}@${withOverrides && (p.id === "steer.message" || p.id === "task.brief.write") ? "abcdef0123" : "0123456789"}`,
      scope: withOverrides && (p.id === "steer.message" || p.id === "task.brief.write") ? "project" : p.id === "instructions" && withOverrides ? "global" : "default",
    })),
    disallowedTools: ["Task", "Workflow", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "EnterWorktree", "ExitWorktree"],
  };
}

/** The outputs of the hub calls the order view makes, for one fixture. */
export function orderCalls(fixture: OrderFixture) {
  const ls = lanes(fixture);
  const working = fixture !== "empty";
  return {
    order_get: {
      order: {
        workstreamId: "W1",
        projectRef: PROJECT,
        title:
          fixture === "long-text"
            ? "A share card on the console: tokens in the last 7 days, the API-price value against the entered monthly plan, a Copy image button and a public snapshot link"
            : "A share card on the console: tokens in the last 7 days",
        state: "running",
        phase: fixture === "empty" ? "planning" : "running",
        needsYou: 0,
        settled: ls.filter((l) => l.status === "done").length,
        total: ls.length,
        lanes: ls.filter((l) => l.status !== "done"),
        prs: ls.flatMap((l) => (l.pr ? [l.pr] : [])),
        createdAt: T(0),
        updatedAt: T(17),
      },
      lead: leadLane(working ? "working" : "idle"),
      doneLanes: ls.filter((l) => l.status === "done"),
      asks: [],
      claims: fixture === "empty" ? [] : [CLAIM],
    },
    workstream_get: { workstream: fixture === "empty" ? {} : { brief: { doneWhen: CHECKS } }, asks: [], decisions: [] },
    thread_tail: { items: [...tail(fixture)].reverse() },
    steers_list: { steers: steers(fixture).reverse() },
    session_prompt_get: { session: sessionPrompt(fixture !== "typical") },
    prompts_list: { prompts: REGISTRY },
    /** Live text for the lead: the streaming message, or 20k streamed lines. */
    streaming:
      fixture === "huge-stream"
        ? streamedLines(20_000)
        : fixture === "conversation" || fixture === "typical"
          ? [{ laneId: "lead-storefront", messageId: "m-live", append: STREAMING }]
          : [],
  };
}
