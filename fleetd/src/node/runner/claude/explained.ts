// What fleetd keeps from or forces on every claude it starts, each item with the reason the docs print (the "Agent
// tools" page, scripts/docs.ts). claude.ts's lists are these items, so the docs can't drift from what fleetd sets.
import type { SessionRole } from "../../sessions/types.ts";

type Why<T> = readonly (readonly [T, string])[];

const WHY_AGENTS =
  "fleetd manages agents. Every agent is a fleetd task with its own session, slot, worktree, lane, steering and receipts, started with spawn_agent.";
const WHY_TASK =
  "fleetd manages agents (spawn_agent). Task and Agent are one tool: init lists Task, the model sees Agent, and denying either removes both.";
const WHY_HEADLESS = "Nobody sits at a terminal to answer it, so the run would stall. Agents use ask or ask_lead.";
const WHY_SCHEDULE = "fleetd schedules work (tasks, wakes), never inside one claude process the node may restart.";
const WHY_WORKTREE = "fleetd owns worktrees, one per writer. A session that moves its own folder can't be resumed.";
const WHY_NESTED =
  "A claude started inside a session runs outside fleetd's slots, with its own subagents and any model. Agents start agents with spawn_agent.";

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

const WHY_UNUSED = "Unused by fleetd's agents, and tool schemas ride on every request.";
const WHY_LEAD_FILES = "A lead with repos never changes files: its agents do. A lead with no repo keeps them.";
const WHY_LEAD_WEB = "A lead with repos has its agents read the web; a lead with no repo keeps it.";

/** Denied to fleetd's agents (leads and task agents) on top of DISALLOWED_WHY; threads a person starts keep them. */
export const AGENT_DISALLOWED_WHY: Why<string> = [
  ["ReportFindings", "Agents report a review with fleetd's own `report`."],
  ["DesignSync", WHY_UNUSED],
  ["NotebookEdit", WHY_UNUSED],
];

const WHY_PRE_PUSH =
  "A writer pushes only a tree the repo's pre-push check passed on (`.fleetd/pre-push.json`): run the check, and push again. A person's push can still skip it.";

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

const WHY_DEVICE = "Screens work as they do for every lead; a final Send or Pay click is the person's, through request_takeover.";

/** Allowed without asking to a lead in `manual` permission mode (every lead, D310). */
export const LEAD_ALLOWED_WHY: Why<string> = [
  ["Read", "A lead reads what the person can, as under full access."],
  ["Edit", "A lead that does its own work writes what the person can; a lead with repos has no Edit."],
  ["Write", "A lead that does its own work writes what the person can; a lead with repos has no Write."],
  ["WebSearch", "A search sends only its query, to the search provider."],
  ["Skill", "Loads a skill's instructions; runs nothing."],
  ["mcp__fleetd", "fleetd's own tools, which the hub checks on every call."],
  ["Bash(agent-device *)", WHY_DEVICE],
];

/** Asked of a lead in `manual` permission mode whatever allows them: claude ranks an ask rule above every allow rule. */
export const LEAD_ASK_WHY: Why<string> = [
  ["WebFetch", "A lead fetches a site unasked only once the person allowed or linked it."],
  ["mcp__fleetd__confirm_step", "A final Confirm on a site goes through the project's approval mode, like a send."],
  ["mcp__fleetd__automation_confirm", "Only the person lets an automation run on its own, on its card."],
  ["mcp__fleetd__project_propose", "Only a person creates a project, on the card a lead's proposal shows them."],
  [
    "mcp__fleetd__project_message",
    "A message to another project's lead, who may open work for it, goes through the project's approval mode, like a send.",
  ],
];

/** Set in every claude fleetd starts. */
export const SUBAGENTS_OFF_ENV_WHY: Why<readonly [string, string]> = [
  [
    ["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1"],
    "Takes run_in_background out of Bash and Agent and refuses it: a background job outlives the turn fleetd tracks.",
  ],
  [["CLAUDE_CODE_DISABLE_WORKFLOWS", "1"], "Removes the Workflow tool: fleetd manages agents."],
  [["CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS", "1"], "Removes the built-in Explore and Plan agents: fleetd manages agents."],
  [["CLAUDE_CODE_DISABLE_AGENT_VIEW", "1"], "Removes the built-in claude agent: fleetd manages agents."],
];

/** Never passed on, and blanked in the settings overlay in case the user's settings set them. */
export const SUBAGENTS_ON_ENV_WHY: Why<string> = [
  ["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "Agent teams: fleetd manages agents."],
  [
    "CLAUDE_CODE_COORDINATOR_MODE",
    "Coordinator mode turns a session into one that only delegates (its tools become Task, ListAgents, SendMessage, TaskStop, Workflow).",
  ],
];

export const AUTO_MEMORY_OFF_WHY =
  "fleetd owns an agent's context (briefs, decisions, instructions). Notes claude keeps per folder would carry stale, unreviewed text from one agent's worktree to the next.";

/** Defaults for every claude fleetd starts: the node's own environment or `claude.env` sets any of them otherwise. */
export const DEFAULT_ENV_WHY: Why<readonly [string, string]> = [
  [["ENABLE_TOOL_SEARCH", "true"], "Tool schemas load when a tool is used, not on every request. fleetd's own tools always load at start."],
];

/** Defaults for a task's agent, like DEFAULT_ENV_WHY; also in its settings overlay. */
export const WORKER_ENV_WHY: Why<readonly [string, string]> = [
  [
    ["BASH_MAX_TIMEOUT_MS", "280000"],
    "No one command outlives a task agent's 5-minute prompt cache: past it, the agent's next request writes its whole context to the cache again. A longer suite is CI's job.",
  ],
];

/** A session's prompt cache TTL by role, unless the node's environment or `claude.env` sets the TTL variables. A
 * 1-hour cache write costs 2x the input price, a 5-minute one 1.25x; reads cost the same. */
export const PROMPT_CACHE_TTL_WHY: Why<readonly [SessionRole, "5m" | "1h"]> = [
  [["assistant", "1h"], "A lead doing its own work idles between a person's messages, like a lead between wakes."],
  [
    ["lead", "1h"],
    "A lead idles between wakes, often more than 5 minutes while reviews and CI run, and would otherwise rewrite its whole context to the prompt cache on those wakes.",
  ],
  [["plain", "1h"], "A person's thread idles while they read and reply."],
  [
    ["worker", "5m"],
    "A task's agent (writer, reader, reviewer, CI fix) works in one burst and ends, so a 1-hour write pays for an hour it never uses.",
  ],
];

const WHY_NESTING = "claude sets it for its own children and treats a process that has it as nested inside another session.";

/** Variables never passed on to a session, even if the node's env has them. */
export const NESTING_VARS_WHY: Why<string> = [
  ["CLAUDECODE", WHY_NESTING],
  ["CLAUDE_CODE_ENTRYPOINT", WHY_NESTING],
  ["CLAUDE_CODE_SSE_PORT", WHY_NESTING],
];

export const HELPER_MODEL_WHY =
  "claude's background helper calls (session titles and the like) run on the default profile's model like every review, not on the haiku model claude picks by default.";

/** Set in every session's environment or settings overlay, besides the subagent switches and auto memory. */
export const SESSION_ENV_WHY: Why<readonly [string, string]> = [
  [["DISABLE_AUTOUPDATER", "1"], "Keeps the claude fleetd checked. An update mid-run would swap the binary under a live session."],
  [["CLAUDE_CODE_STARTUP_FAILURE_RESULTS", "1"], "A refusal at startup arrives as a result fleetd can read, not only as stderr."],
];

/** The items of a table, as the launch code uses them. */
export const items = <T>(table: Why<T>): T[] => table.map(([item]) => item);
/** The `[name, value]` items of an environment table. */
export const pairs = (table: Why<readonly [string, string]>): [string, string][] => table.map(([[k, v]]) => [k, v]);
