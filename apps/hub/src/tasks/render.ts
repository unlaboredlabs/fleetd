// Text the hub writes for tasks: the branch name, the task's first message, its line in the lead digest, and the
// result the lead receives inline in its wake. Pure.
import type { Brief, Task, TaskId, TaskResult } from "@fleetd/contracts";
import { describeCheck } from "../leads/digest.ts";
import { receiptsLine } from "../receipts/count.ts";

export const TAIL_MAX = 2000;
const SLUG_MAX = 40;

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Lowercase ASCII words joined by "-", cut at a word boundary; "task" when nothing is left. */
export const slugOf = (title: string) => {
  const words = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "");
  let slug = "";
  for (const w of words) {
    const next = slug === "" ? w : `${slug}-${w}`;
    if (next.length > SLUG_MAX) break;
    slug = next;
  }
  return slug === "" ? (words[0]?.slice(0, SLUG_MAX) ?? "task") || "task" : slug;
};

export const branchFor = (taskId: TaskId, title: string) => `fleetd/${taskId}-${slugOf(title)}`;

/** The last `max` characters, starting with "…" when cut. */
export const tailOf = (text: string, max = TAIL_MAX) => {
  const t = text.trim();
  return t.length <= max ? t : `…${t.slice(t.length - max + 1)}`;
};

const PR_URL = /https?:\/\/[^\s"'<>()]+?\/(?:pull|pulls|merge_requests)\/\d+/gu;

/** The last pull or merge request URL in `texts`, read in order. */
export const findPrUrl = (texts: ReadonlyArray<string | undefined>): string | undefined => {
  let found: string | undefined;
  for (const text of texts) for (const m of text?.matchAll(PR_URL) ?? []) found = m[0];
  return found;
};

export interface PromptInput {
  readonly task: Pick<Task, "taskId" | "kind" | "title" | "prompt" | "areas" | "workstreamId" | "serves">;
  readonly projectTitle: string;
  /** Absent while the workstream is a draft. */
  readonly brief?: Brief | undefined;
  /** The globs of each leased area. */
  readonly areaGlobs: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Write tasks: their branch and the branch it starts from. */
  readonly branch?: string | undefined;
  readonly baseBranch?: string | undefined;
}

/** The task's first message: the lead's text with the brief, the areas and the rules around it. */
export const renderTaskPrompt = (input: PromptInput): string => {
  const { task, brief } = input;
  const context: Array<string> = [];
  if (brief !== undefined) {
    context.push(`Goal: ${oneLine(brief.goal, 1000)}`);
    context.push(`Done when: ${brief.doneWhen.map((c, i) => `${i + 1}) ${oneLine(describeCheck(c), 200)}`).join("; ")}`);
  }
  if (task.serves !== undefined) context.push(`This task serves: ${oneLine(task.serves, 200)}`);

  const rules: Array<string> = [];
  if (task.kind === "write") {
    const areas = task.areas.map((a) => `${a} (${(input.areaGlobs[a] ?? []).join(", ")})`).join("; ");
    rules.push(`- Only change files in these areas: ${areas}. Changes anywhere else are flagged as out of area.`);
    const base = input.baseBranch === undefined ? "the default branch" : `the default branch (${input.baseBranch})`;
    rules.push(
      `- You work in your own worktree on branch ${input.branch ?? "your task branch"}. Commit to your branch; do not merge; do not push to ${base}.`,
    );
  } else {
    rules.push("- This is a read-only task: do not change, commit or push any files.");
  }
  rules.push("- Do the task yourself; do not hand it to subagents.");
  rules.push("- End with a one-paragraph result: what you did, what is left, and anything the lead must decide.");

  return [
    `You are fleetd task ${task.taskId} (${task.kind}) for workstream ${task.workstreamId} in project ${oneLine(input.projectTitle, 80)}: ${task.title}`,
    "",
    "## Task",
    task.prompt.trim(),
    ...(context.length === 0 ? [] : ["", "## Workstream", ...context]),
    "",
    "## Rules",
    ...rules,
  ].join("\n");
};

const VERB: Record<TaskResult["status"], string> = { done: "completed", failed: "failed", cancelled: "was cancelled" };

/** The "why you are woken" entry for a finished task: its whole result tail, inline. */
export const taskResultLines = (t: { readonly taskId: TaskId; readonly title: string; readonly result: TaskResult }): string => {
  const { result } = t;
  const where = [
    ...(result.branch === undefined ? [] : [`branch ${result.branch}`]),
    ...(result.prUrl === undefined ? [] : [`PR ${result.prUrl}`]),
  ];
  const head = `- ${t.taskId} ${VERB[result.status]}: ${oneLine(t.title, 80)}${where.length === 0 ? "" : ` (${where.join(", ")})`}`;
  const tail = result.tail.trim() === "" ? ["  > (no final message)"] : result.tail.trim().split("\n").map((l) => `  > ${l}`.trimEnd());
  const next =
    result.status === "cancelled"
      ? "  next: nothing; spawn a new task if the work is still needed."
      : `  next: judge the result; \`fleetd task message ${t.taskId} "<text>"\` continues the same thread.`;
  // M6 receipts, counted by the hub; absent on results stored before them.
  const receipts = receiptsLine(result);
  return [head, ...(receipts === undefined ? [] : [`  ${receipts}`]), "  result:", ...tail, next].join("\n");
};

/** The "why you are woken" entry for a task waiting on input: its question, inline. */
export const taskWaitingLines = (t: { readonly taskId: TaskId; readonly title: string; readonly question: string }): string =>
  [
    `- ${t.taskId} is waiting for input: ${oneLine(t.title, 80)}`,
    "  question:",
    ...t.question.trim().split("\n").map((l) => `  > ${l}`.trimEnd()),
    `  next: answer it with \`fleetd task message ${t.taskId} "<answer>"\`, or \`fleetd task cancel ${t.taskId}\`. Ask the human only if it is a product, money, credential or irreversible call.`,
  ].join("\n");

const model = (t: Task) => `${t.model}/${t.effort}`;

/** One digest line per task: running and idle, then queued with reasons, then those that ended since `since`. */
export const taskDigestLines = (tasks: ReadonlyArray<Task>, since: string | undefined): ReadonlyArray<string> => {
  const live = tasks.filter((t) => t.state === "running" || t.state === "idle");
  const queued = tasks.filter((t) => t.state === "queued");
  const ended = tasks.filter(
    (t) => (t.state === "done" || t.state === "failed" || t.state === "cancelled") && (since === undefined || (t.endedAt ?? "") > since),
  );
  const title = (t: Task) => oneLine(t.title, 80);
  return [
    ...live.map(
      (t) => `- ${t.taskId} ${t.state === "idle" ? "idle, waiting for input" : "running"} (${t.kind}, ${model(t)}): ${title(t)}${t.branch === undefined ? "" : ` [${t.branch}]`}`,
    ),
    ...queued.map((t) => `- ${t.taskId} queued (${t.kind}): ${title(t)}; ${t.queuedReason ?? "waiting"}`),
    ...ended.map((t) => {
      const first = t.result === undefined ? "" : oneLine(t.result.tail.replace(/^…/u, ""), 160);
      return `- ${t.taskId} ${t.state} since your last wake: ${title(t)}${first === "" ? "" : ` → ${first}`}`;
    }),
  ];
};
