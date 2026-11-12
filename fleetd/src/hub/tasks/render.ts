// Text the hub writes for tasks: how a task's texts are cut and what a cut
// must keep, the branch name, the task's first message, its line in the lead digest, and its event lines in the lead's
// wake. Pure. Lengths count UTF-16 units.
import type { Brief, Decision, MachineId, Task, TaskKind, TaskRecovery, TaskResult } from "../../shared/contracts.ts";
import type { WorktreeSource } from "../../shared/sessions.ts";
import { jsPrefix, jsSuffix } from "../../shared/text.ts";
import { type Ended, renderEvent } from "../leads/events.ts";
import type { PromptSet } from "../prompts/set.ts";
import { line as baseLine } from "./base.ts";

export const TAIL_MAX = 2000;
const REFS = "Refs: ";

/** The text on one line, whitespace runs one space; cut to `max` units with "…" last. */
export function oneLine(text: string, max: number): string {
  const flat = text.split(/\s+/).filter(Boolean).join(" ");
  return flat.length > max ? `${jsPrefix(flat, max - 1)}…` : flat;
}

const PR_URL = /https?:\/\/[^\s"'<>()]+?\/(?:pull|pulls|pull-requests|pullrequest|merge_requests)\/[0-9]+/g;

/** Every PR URL in `texts`, in order. */
export const prUrls = (texts: string[]) => texts.flatMap((t) => [...t.matchAll(PR_URL)].map((m) => m[0]));

const isAttachmentId = (token: string) => /^F[1-9][0-9]*$/.test(token);

/** 7 to 40 lowercase hex digits with a letter and a digit, so neither a number nor a hex-looking word. */
const isSha = (token: string) => /^[0-9a-f]{7,40}$/.test(token) && /[0-9]/.test(token) && /[a-f]/.test(token);

/** What a result names that a cut must never lose, each once: its PR URLs, attachment ids, then commit SHAs. */
export function refsOf(text: string): string[] {
  const tokens = text.match(/[0-9A-Za-z_-]+/g) ?? [];
  const refs: string[] = [];
  for (const r of [...prUrls([text]), ...tokens.filter(isAttachmentId), ...tokens.filter(isSha)]) {
    if (!refs.includes(r)) refs.push(r);
  }
  return refs;
}

/**
 * `text` trimmed, and when longer than `max` UTF-16 units its head and its tail around "…", with a last line
 * "Refs: …" lifting every PR URL, attachment id and commit SHA of the whole text, so no cut loses them.
 */
export function resultText(text: string, max: number): string {
  let t = text.trim();
  if (t.length <= max) return t;
  const refs = refsOf(t);
  // A text cut once already ends in its own Refs line: the new one replaces it, and holds all of its refs.
  const at = t.lastIndexOf(`\n\n${REFS}`);
  if (at >= 0 && !t.slice(at + 2 + REFS.length).includes("\n")) t = t.slice(0, at).trimEnd();
  const line = refs.length === 0 ? "" : `\n\n${oneLine(`${REFS}${refs.join(" ")}`, Math.floor(max / 2))}`;
  const room = max - line.length - "\n…\n".length;
  const head = jsPrefix(t, Math.floor(room / 2)).trimEnd();
  const tail = jsSuffix(t, room - head.length).trimStart();
  return `${head}\n…\n${tail}${line}`;
}

/** A task's whole final result, as `agents` with taskId returns it: room for a long report, cut past it. */
export const FULL_RESULT_CAP = 32 * 1024;

/**
 * A finished task's whole result, as `agents` with its taskId returns it: undefined when `resultText` keeps it whole in
 * TAIL_MAX, else its first FULL_RESULT_CAP units, then a last line saying where it was cut.
 */
export function fullResultText(text: string): string | undefined {
  const t = text.trim();
  if (t.length <= TAIL_MAX) return undefined;
  if (t.length <= FULL_RESULT_CAP) return t;
  return `${jsPrefix(t, FULL_RESULT_CAP).trimEnd()}\n\n[cut at ${FULL_RESULT_CAP / 1024} KB of ${Math.ceil(t.length / 1024)} KB]`;
}

// --- the branch, the task's prompt and its lines (render.rs) ---

const SLUG_MAX = 40;
export const DEFAULT_BRANCH_PREFIX = "fleetd/";

/** Lowercase ASCII words joined by "-", cut at a word boundary; "task" when nothing is left. */
export function slugOf(title: string): string {
  const folded = title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const words = folded.split(/[^a-z0-9]/).filter(Boolean);
  let slug = "";
  for (const w of words) {
    const next = slug === "" ? w.length : slug.length + 1 + w.length;
    if (next > SLUG_MAX) break;
    slug = slug === "" ? w : `${slug}-${w}`;
  }
  if (slug !== "") return slug;
  return words[0] !== undefined ? words[0].slice(0, SLUG_MAX) : "task";
}

/** A write task's branch, the only branch fleetd names. `prefix` is the policy's `branchPrefix`. */
export const branchFor = (prefix: string | undefined, taskId: string, title: string) =>
  `${prefix ?? DEFAULT_BRANCH_PREFIX}${taskId}-${slugOf(title)}`;

/** The last `max` units, starting with "…" when cut. */
export function tailOf(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `…${jsSuffix(t, max - 1)}`;
}

/** What `renderTaskPrompt` reads. */
export type PromptInput = {
  task: Task;
  projectTitle: string;
  /** Absent while the workstream is a draft. */
  brief?: Brief;
  /** The brief's done-when lines as text, whole. */
  doneWhen?: string;
  /** The decisions the brief names by id or key, whole. */
  decisions: Decision[];
  /** Write tasks: their branch. */
  branch?: string;
  baseBranch?: string;
  /** Write tasks: the work in flight elsewhere they may overlap (`duplicates.forWriter`). */
  elsewhere: string[];
  /** Write tasks: the memory of whoever started the order and the project's `MEMORY.md`, or empty. */
  memory: string;
};

/** Where a read or review task works, for its brief's `{{workspace}}`. */
function workspaceLine(kind: TaskKind, baseBranch: string | undefined): string {
  const own =
    "You may build and run tests there; fleetd removes it when the task ends. Never work in the project's own checkout, which is the human's.";
  if (baseBranch === undefined) {
    return "Your current directory is the project's own checkout, which is the human's: read it as it is, and never check out, build or write anything there.";
  }
  if (kind === "review") {
    return `Your current directory is a detached git worktree of your own, at the PR's head when fleetd could fetch it from the remote the PR belongs to, else at origin/${baseBranch}. Check with \`git log -1\` against the PR's head commit; if it isn't that, fetch the PR's head yourself and check it out in this worktree. origin/${baseBranch} is fresh, to diff against. ${own}`;
  }
  return `Your current directory is a detached git worktree of your own, at origin/${baseBranch} as fetched at your start. ${own}`;
}

/** A brief's whole text, to find the decisions it names. */
export const briefText = (b: Brief) => [b.goal, b.why, ...b.pointers, ...b.constraints, ...b.doneWhen].join("\n");

/** `- D12 api.health.path = /healthz (why: ...)`, whole; one no longer in force says so. */
function decisionLine(d: Decision): string {
  const why = d.why !== undefined ? ` (why: ${d.why.trim()})` : "";
  const state = d.state === "superseded" ? " [superseded]" : d.state === "retired" ? " [retired]" : "";
  return `- ${d.decisionId}${state} ${d.key} = ${d.value.trim()}${why}`;
}

/** A task's system prompt (its standing rules, which a compaction never summarizes) and its first message. */
export type TaskPrompt = { system: string; first: string };

/** The heading a brief's standing rules start at (`task.brief.*`). */
const RULES = "\n## Rules\n";

/** The task's brief: its rules on go in its system prompt, all before them in its first message. */
export function renderTaskPrompt(set: PromptSet, input: PromptInput): TaskPrompt {
  const task = input.task;
  const context: string[] = [];
  const brief = input.brief;
  if (brief) {
    context.push(`Goal: ${oneLine(brief.goal, 1000)}`);
    context.push(`Why: ${brief.why.trim()}`);
    for (const [name, lines] of [
      ["Pointers", brief.pointers],
      ["Constraints", brief.constraints],
    ] as const) {
      if (lines.length > 0) {
        context.push(`${name}:`);
        context.push(...lines.map((l) => `- ${l.trim()}`));
      }
    }
    context.push(`Done when: ${input.doneWhen ?? ""}`);
  }
  if (input.decisions.length > 0) {
    context.push("Decisions it names:");
    context.push(...input.decisions.map(decisionLine));
  }
  const workstream = context.length === 0 ? "" : `\n\n## Workstream\n${context.join("\n")}`;
  const elsewhere =
    input.elsewhere.length === 0
      ? ""
      : `\n\n## Elsewhere\nWork in flight that may overlap yours. Don't redo it; if yours is the same work, stop and ask your lead.\n${input.elsewhere
          .map((l) => `- ${oneLine(l, 300)}`)
          .join("\n")}`;
  const vars = {
    taskId: task.taskId,
    kind: task.kind,
    workstreamId: task.workstreamId,
    project: oneLine(input.projectTitle, 80),
    title: task.title,
    task: task.prompt.trim(),
    workstream,
    elsewhere,
    branch: input.branch ?? "<your branch>",
    baseBranch: input.baseBranch ?? "<default branch>",
    workspace: workspaceLine(task.kind, input.baseBranch),
  };
  const text = set.render(`task.brief.${task.kind}`, vars);
  // The template's own heading is the last: the lead's text and the workstream come before it, and may hold one too.
  const at = text.lastIndexOf(RULES);
  const [first, rules] = at >= 0 ? [text.slice(0, at).trimEnd(), text.slice(at + 1)] : [text.trimEnd(), ""];
  let system = set.withInstructions(rules.trimEnd());
  if (input.memory !== "") system = `${system}\n\n${input.memory}`;
  return { system: system.trimStart(), first };
}

/** The lead's event line for a finished task. `escalated`: its run died and fleetd did not resume it. */
export function taskResultLines(taskId: string, title: string, result: TaskResult, escalated: boolean): string {
  const place: string[] = [];
  if (result.branch !== undefined) place.push(`branch ${result.branch}`);
  if (result.prUrl !== undefined) place.push(`PR ${result.prUrl}`);
  const ended: Ended =
    result.status === "failed" && escalated ? "not_resumed" : result.status === "done" ? "done" : result.status === "failed" ? "failed" : "cancelled";
  return renderEvent({
    kind: "agent_ended",
    task: taskId,
    ended,
    title,
    place: place.length === 0 ? "" : ` (${place.join(", ")})`,
    result: withWholeHint(taskId, result.tail),
  });
}

/** A result tail `resultText` cut, with a last line on reading it whole. */
const withWholeHint = (taskId: string, tail: string) =>
  tail.includes("\n…\n") ? `${tail}\n(Cut: \`agents\` with taskId ${taskId} has it whole, in fullResult.)` : tail;

/** `" [branch]"`, or nothing. */
const branchPlace = (task: Task) => (task.branch !== undefined ? ` [${task.branch}]` : "");

/** What became of a resumed task's worktree: as it was, or rebuilt by its node from what was left of its branch. */
function worktreeWords(task: Task, rebuilt: WorktreeSource | undefined): string {
  const branch = task.branch ?? "its branch";
  switch (rebuilt) {
    case "local":
      return `Its worktree was gone and was rebuilt from its local branch ${branch}: its commits are there, uncommitted changes are lost. Nothing for you to do.`;
    case "remote":
      return `Its worktree and local branch were gone, so the worktree was rebuilt from origin/${branch} as pushed: unpushed commits and uncommitted changes are lost. Nothing for you to do.`;
    case "base":
      return `Its worktree was gone and ${branch} was neither on the machine nor pushed, so it starts again on a new ${branch} from the default branch: its earlier work is lost.`;
    default:
      return "It goes on in its own worktree; nothing for you to do.";
  }
}

/** The lead's quiet line for a dead task fleetd resumed: why its run ended, what it was doing, and its worktree. */
export const taskRecoveredLines = (task: Task, recovery: TaskRecovery, doing: string, rebuilt: WorktreeSource | undefined) =>
  renderEvent({
    kind: "agent_recovered",
    task: task.taskId,
    title: task.title,
    place: branchPlace(task),
    attempt: task.attempt,
    used: `${recovery.count} of ${recovery.max} recoveries used`,
    cause: recovery.lastCauseText,
    doing,
    worktree: worktreeWords(task, rebuilt),
  });

/** The lead's line for a message to a task that never reached it. */
export const taskMessageNotSentLines = (task: Task, why: string, text: string) =>
  renderEvent({ kind: "message_not_sent", task: task.taskId, title: task.title, why, text });

/** What each agent running on a machine hears once when git there can't reach GitHub: its lead already knows. */
export const GITHUB_DOWN =
  "This machine can't reach GitHub right now; keep your work committed and push when it's back. fleetd tells you when it is, and your lead knows: go on with what doesn't need GitHub.";

/** What those agents hear once when it can again. */
export const GITHUB_BACK = "This machine reaches GitHub again: push what you committed meanwhile, and go on.";

/** The machine a task runs on, as its lead reads it: its project's. */
export const runsOn = (task: Task): MachineId => task.projectRef.machineId;

/** The lead's quiet line for a running task whose machine has been offline for `minutes`. */
export const taskUnreachableLines = (task: Task, minutes: number) =>
  renderEvent({ kind: "agent_unreachable", task: task.taskId, title: task.title, place: branchPlace(task), machine: runsOn(task), minutes });

/** The lead's quiet line for a finished writer whose PR lookup the host refused. */
export const taskPrSkippedLines = (taskId: string, why: string) => renderEvent({ kind: "agent_pr_skipped", task: taskId, why });

/** The lead's quiet line for a finished task's PR, found after its result line went out. */
export const taskPrLines = (taskId: string, prUrl: string) => renderEvent({ kind: "agent_pr", task: taskId, prUrl });

/** The lead's event line for a task waiting on input: its question, inline. */
export const taskWaitingLines = (taskId: string, title: string, question: string) =>
  renderEvent({ kind: "agent_waiting", task: taskId, title, question });

/**
 * One digest line per task: running and idle, then queued with reasons, then those that ended since `since` and done
 * ones still waiting on CI. `offline` says since when a machine is offline (`HH:MM` UTC); `waits` gives a task's open
 * wait_ci URLs.
 */
export function taskDigestLines(
  tasks: Task[],
  since: string | undefined,
  now: string,
  offline: (machine: string) => string | undefined,
  waits: (taskId: string) => string[],
): string[] {
  const title = (t: Task) => oneLine(t.title, 80);
  const out: string[] = [];
  for (const t of tasks.filter((t) => t.state === "running" || t.state === "idle")) {
    const branch =
      t.branch === undefined ? "" : t.base !== undefined ? ` [${t.branch}, ${baseLine(t.base, now)}]` : ` [${t.branch}]`;
    const state = t.state === "idle" ? "idle, waiting for input" : "running";
    // Resumed on its own after a death: the lead needn't continue it.
    const r = t.recovery;
    const recovered =
      r?.resumedAt !== undefined
        ? `; ${r.mode === "fresh" ? "restarted fresh" : "resumed automatically"} after ${r.lastCauseText}, ${r.count} of ${r.max} recoveries used`
        : "";
    // Its machine is away: it resumes when that is back, so the lead needn't continue it either.
    const machine = runsOn(t);
    const at = t.state === "running" ? offline(machine) : undefined;
    const away = at !== undefined ? `; ${machine} offline since ${at} UTC, it resumes when ${machine} is back` : "";
    out.push(`- ${t.taskId} ${state} (${t.kind}, ${t.profile ?? "high"}): ${title(t)}${branch}${recovered}${away}`);
  }
  for (const t of tasks.filter((t) => t.state === "queued")) {
    out.push(`- ${t.taskId} queued (${t.kind}): ${title(t)}; ${t.queuedReason ?? "waiting"}`);
  }
  const endedSince = (t: Task) => since === undefined || (t.endedAt ?? "") > since;
  const shown = tasks.filter((t) =>
    t.state === "done" ? endedSince(t) || waits(t.taskId).length > 0 : t.state === "failed" || t.state === "cancelled" ? endedSince(t) : false,
  );
  for (const t of shown) {
    // A wake's event lines carry the result of a task that ended since the last one; only a first message has none.
    let first = "";
    if (t.result && since === undefined) {
      const r = t.result;
      const tail = r.tail.startsWith("…") ? r.tail.slice(1) : r.tail;
      const cut = tail.lastIndexOf(`\n\n${REFS}`);
      const body = cut >= 0 ? tail.slice(0, cut) : tail;
      const shownText = oneLine(body, 160);
      // The line is cut, its refs never: those it or the PR beside the title already show are left out.
      const seen = refsOf(shownText);
      const refs = refsOf(tail).filter((p) => !seen.includes(p) && (r.prUrl === undefined || r.prUrl !== p));
      first = refs.length === 0 ? shownText : `${shownText} ${REFS}${refs.join(" ")}`;
    }
    const arrow = first === "" ? "" : ` → ${first}`;
    const pr = t.result?.prUrl !== undefined ? ` [${t.result.prUrl}]` : "";
    const when = endedSince(t) ? " since your last wake" : "";
    const urls = waits(t.taskId);
    const waiting = urls.length === 0 || t.state !== "done" ? "" : `; waits on CI, and wait_ci wakes it as each ends: ${urls.join(" ")}`;
    out.push(`- ${t.taskId} ${t.state}${when}: ${title(t)}${pr}${waiting}${arrow}`);
  }
  return out;
}
