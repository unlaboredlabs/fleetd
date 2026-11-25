// What fleetd keeps from or forces on every claude it starts, each item with the reason the docs print (the "Agent
// tools" page, scripts/docs.ts). claude.ts's lists are these items, so the docs can't drift from what fleetd sets.
import type { SessionRole } from "../../sessions/types.ts";

type Why<T> = readonly (readonly [T, string])[];

const WHY_AGENTS =
  "fleetd starts and tracks every agent itself, with spawn_agent.";
const WHY_TASK =
  "fleetd starts and tracks every agent itself, with spawn_agent. Task and Agent are one tool: blocking either removes both.";
const WHY_HEADLESS = "Nobody sits at a terminal to answer it, so the run would stall. Agents ask through fleetd instead.";
const WHY_SCHEDULE = "fleetd schedules work itself, so a restart can't lose it.";
const WHY_WORKTREE = "fleetd gives each writer its own worktree. A session that moves to another folder can't be resumed.";
const WHY_NESTED =
  "A claude started inside a session would run outside fleetd's limits, on any model. Agents start agents with spawn_agent.";

/**
 * Tools no fleetd session gets (names from claude 2.1.302's `system/init` tool list), then the Bash rules against a
 * nested claude. claude matches `Bash(claude *)` in every part of a compound command and past the wrappers it strips,
 * but no other spelling of the program, so the rest name the obvious ones. Each starts with literal text, never `*`:
 * claude matches a rule against a part's whole text, quoted arguments and heredocs included, and at times against the
 * whole chain, so `*sh -*c *claude*` refused `git push -q …; gh pr create --body "…claude.com…"`. A script that hides
 * the name still gets through: these keep agents honest, they are not a sandbox.
 */
export const DISALLOWED_WHY: Why<string> = [
  ["Task", WHY_TASK],
  ["Agent", WHY_TASK],
  ["Workflow", WHY_AGENTS],
  ["ListAgents", WHY_AGENTS],
  ["SendMessage", WHY_AGENTS],
  ["TaskStop", WHY_AGENTS],
  ["TaskOutput", WHY_AGENTS],
  ["TeamCreate", WHY_AGENTS],
  ["TeamDelete", WHY_AGENTS],
  ["AskUserQuestion", WHY_HEADLESS],
  ["EnterPlanMode", WHY_HEADLESS],
  ["ExitPlanMode", WHY_HEADLESS],
  ["CronCreate", WHY_SCHEDULE],
  ["CronDelete", WHY_SCHEDULE],
  ["CronList", WHY_SCHEDULE],
  ["ScheduleWakeup", WHY_SCHEDULE],
  ["EnterWorktree", WHY_WORKTREE],
  ["ExitWorktree", WHY_WORKTREE],
  ["Bash(claude *)", WHY_NESTED],
  ["Bash(/*/claude *)", WHY_NESTED],
  ["Bash(~/*/claude *)", WHY_NESTED],
  ["Bash($HOME/*/claude *)", WHY_NESTED],
  ["Bash(./*/claude *)", WHY_NESTED],
  ["Bash(/*/claude/versions/*)", WHY_NESTED],
  ["Bash(~/*/claude/versions/*)", WHY_NESTED],
  ["Bash($HOME/*/claude/versions/*)", WHY_NESTED],
  ["Bash(npx claude *)", WHY_NESTED],
  ["Bash(bunx claude *)", WHY_NESTED],
  ["Bash(npx *@anthropic-ai/claude-code*)", WHY_NESTED],
  ["Bash(bunx *@anthropic-ai/claude-code*)", WHY_NESTED],
  ["Bash(npm exec *@anthropic-ai/claude-code*)", WHY_NESTED],
  ["Bash(pnpm dlx *@anthropic-ai/claude-code*)", WHY_NESTED],
  ["Bash(sh -*c *claude -*)", WHY_NESTED],
  ["Bash(bash -*c *claude -*)", WHY_NESTED],
  ["Bash(zsh -*c *claude -*)", WHY_NESTED],
  ["Bash(/*sh -*c *claude -*)", WHY_NESTED],
  ["Bash(env *claude -*)", WHY_NESTED],
  ["Bash(exec *claude -*)", WHY_NESTED],
  ["Bash(xargs *claude -*)", WHY_NESTED],
];

const WHY_UNUSED = "fleetd's agents don't use it, and every tool adds to each request.";
const WHY_LEAD_FILES = "A lead with repos never changes files: its agents do. A lead with no repo keeps them.";
const WHY_LEAD_WEB = "A lead with repos has its agents read the web; a lead with no repo keeps it.";

/** Denied to fleetd's agents (leads and task agents) on top of DISALLOWED_WHY; threads a person starts keep them. */
export const AGENT_DISALLOWED_WHY: Why<string> = [
  ["ReportFindings", "Agents report a review with fleetd's own `report`."],
  ["DesignSync", WHY_UNUSED],
  ["NotebookEdit", WHY_UNUSED],
];

const WHY_PRE_PUSH =
  "A writer may push only after the repo's pre-push check passed (`.fleetd/pre-push.json`). A person's push can still skip it.";

/** Denied to a task's agent: the ways past fleetd's pre-push gate an agent reaches for first. */
export const TASK_DISALLOWED_WHY: Why<string> = [
  ["Bash(git push *--no-verify*)", WHY_PRE_PUSH],
  ["Bash(git *core.hooksPath*)", WHY_PRE_PUSH],
  ["Bash(git *core.hookspath*)", WHY_PRE_PUSH],
];

/** Denied to a lead with repos (the lead role); a lead with no repo (the assistant role) keeps them. */
export const LEAD_DISALLOWED_WHY: Why<string> = [
  ["Edit", WHY_LEAD_FILES],
  ["Write", WHY_LEAD_FILES],
  ["WebFetch", WHY_LEAD_WEB],
  ["WebSearch", WHY_LEAD_WEB],
];

const WHY_DEVICE = "Phone screens work for a lead as for any agent. A final Send or Pay is the person's, through request_takeover.";

/** Allowed without asking to a lead in `manual` permission mode (every lead, D310). */
export const LEAD_ALLOWED_WHY: Why<string> = [
  ["Read", "A lead reads what the person can, as under full access."],
  ["Edit", "A lead that does its own work writes what the person can; a lead with repos has no Edit."],
  ["Write", "A lead that does its own work writes what the person can; a lead with repos has no Write."],
  ["WebSearch", "A search sends only its query, to the search provider."],
  ["Skill", "Loads a skill's instructions; runs nothing."],
  ["mcp__fleetd", "fleetd's own tools. The workspace checks every call."],
  ["Bash(agent-device *)", WHY_DEVICE],
];

/** Asked of a lead in `manual` permission mode whatever allows them: claude ranks an ask rule above every allow rule. */
export const LEAD_ASK_WHY: Why<string> = [
  ["WebFetch", "A lead fetches a site unasked only once the person allowed or linked it."],
  ["mcp__fleetd__confirm_step", "A final Confirm on a site goes through the bot's approval mode, like a send."],
  ["mcp__fleetd__automation_confirm", "Only the person lets an automation run on its own, on its card."],
  ["mcp__fleetd__project_propose", "Only a person creates a bot, on the card a lead's proposal shows them."],
];

/** Set in every claude fleetd starts. */
export const SUBAGENTS_OFF_ENV_WHY: Why<readonly [string, string]> = [
  [
    ["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1"],
    "Turns off background jobs in Bash: one would outlive the turn fleetd tracks.",
  ],
  [["CLAUDE_CODE_DISABLE_WORKFLOWS", "1"], "Removes the Workflow tool: fleetd starts agents itself."],
  [["CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS", "1"], "Removes the built-in Explore and Plan agents: fleetd starts agents itself."],
  [["CLAUDE_CODE_DISABLE_AGENT_VIEW", "1"], "Removes the built-in claude agent: fleetd starts agents itself."],
];

/** Never passed on, and blanked in the settings overlay in case the user's settings set them. */
export const SUBAGENTS_ON_ENV_WHY: Why<string> = [
  ["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "Agent teams: fleetd starts agents itself."],
  [
    "CLAUDE_CODE_COORDINATOR_MODE",
    "Coordinator mode turns a session into one that only hands work to subagents.",
  ],
];

export const AUTO_MEMORY_OFF_WHY =
  "fleetd decides what each agent is told. Notes claude keeps per folder would carry stale text from one agent to the next.";

/** Defaults for every claude fleetd starts: the node's own environment or `claude.env` sets any of them otherwise. */
export const DEFAULT_ENV_WHY: Why<readonly [string, string]> = [
  [["ENABLE_TOOL_SEARCH", "true"], "Tools load when used, not on every request. fleetd's own tools always load at start."],
];

/** Defaults for a task's agent, like DEFAULT_ENV_WHY; also in its settings overlay. */
export const WORKER_ENV_WHY: Why<readonly [string, string]> = [
  [
    ["BASH_MAX_TIMEOUT_MS", "280000"],
    "No command outlives an agent's 5-minute prompt cache, which would cost a full rewrite of its context. Long test suites are CI's job.",
  ],
];

/**
 * Set for a lead, with or without repos; also in its settings overlay. claude (2.1.302 to 2.1.314) reads
 * CLAUDE_CODE_SILENT_TURN_REMINDER as on, off or unset: "0", "false", "no" and "off" are off, and set it wins over
 * claude's own default for the reminder.
 */
export const LEAD_ENV_WHY: Why<readonly [string, string]> = [
  [
    ["CLAUDE_CODE_SILENT_TURN_REMINDER", "0"],
    "Turns off claude's mid-turn reminder to post an update. Only a lead turn's last text reaches the chat.",
  ],
];

/** A session's prompt cache TTL by role, unless the node's environment or `claude.env` sets the TTL variables. A
 * 1-hour cache write costs 2x the input price, a 5-minute one 1.25x; reads cost the same. */
export const PROMPT_CACHE_TTL_WHY: Why<readonly [SessionRole, "5m" | "1h"]> = [
  [["assistant", "1h"], "A lead with no repo waits between a person's messages."],
  [
    ["lead", "1h"],
    "A lead often waits more than 5 minutes for reviews and CI. A longer cache saves rewriting its whole context.",
  ],
  [["plain", "1h"], "Your own thread waits while you read and reply."],
  [
    ["worker", "5m"],
    "An agent works in one burst and ends, so a 1-hour cache would go unused.",
  ],
];

const WHY_NESTING = "claude would treat the session as nested inside another one.";

/** Variables never passed on to a session, even if the node's env has them. */
export const NESTING_VARS_WHY: Why<string> = [
  ["CLAUDECODE", WHY_NESTING],
  ["CLAUDE_CODE_ENTRYPOINT", WHY_NESTING],
  ["CLAUDE_CODE_SSE_PORT", WHY_NESTING],
];

export const HELPER_MODEL_WHY =
  "claude's background calls (like session titles) use the default profile's model, not Haiku.";

/** Set in every session's environment or settings overlay, besides the subagent switches and auto memory. */
export const SESSION_ENV_WHY: Why<readonly [string, string]> = [
  [["DISABLE_AUTOUPDATER", "1"], "Keeps the claude version fleetd tested. An update mid-run would swap it under a live session."],
  [["CLAUDE_CODE_STARTUP_FAILURE_RESULTS", "1"], "A failed start comes back as a result fleetd can read and show."],
];

/** The items of a table, as the launch code uses them. */
export const items = <T>(table: Why<T>): T[] => table.map(([item]) => item);
/** The `[name, value]` items of an environment table. */
export const pairs = (table: Why<readonly [string, string]>): [string, string][] => table.map(([[k, v]]) => [k, v]);
