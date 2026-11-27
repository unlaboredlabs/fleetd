// One agent's page on the phone (Agent.tsx), from the workspace's answers: its head line while it works and once it
// ends, its steps as rows, and which of a bot's agents its Info lists. Pure, so the tests pin them; the finished
// words are the desktop's (shared/finished.ts).
import { changeStat, doingWords, endedWord, fileParts, ranFor, sentenceCase, type AgentRow, type Task, type WorkStep } from "../../desktop";

const ROLE: Record<AgentRow["role"], string> = { lead: "Lead", implementer: "Writer", reader: "Reader", reviewer: "Reviewer", verifier: "Verifier", qa: "QA" };
const KIND_ROLE: Record<Task["kind"], AgentRow["role"]> = { write: "implementer", read: "reader", review: "reviewer" };

export const roleWord = (role: AgentRow["role"]): string => ROLE[role];
export const kindRole = (kind: Task["kind"]): AgentRow["role"] => KIND_ROLE[kind];

const ENDED = new Set<AgentRow["status"]>(["done", "failed", "cancelled"]);
export const hasEnded = (row: Pick<AgentRow, "status">): boolean => ENDED.has(row.status);

/** Its head's line once it ended: "Finished · ran 12m 40s", "Stopped". */
export const endedLine = (task: Pick<Task, "state" | "startedAt" | "endedAt" | "createdAt">): string | undefined => {
  const word = endedWord(task.state);
  if (word === undefined) return undefined;
  const ran = ranFor(task);
  return ran === undefined ? word : `${word} · ran ${ran}`;
};

/** What it does now, in a sentence: "Editing `app.ts`" as "Editing app.ts"; undefined when nothing is known. */
export const nowWords = (row: Pick<AgentRow, "live">): string | undefined => {
  const a = row.live?.activity?.activity;
  return a === undefined ? undefined : sentenceCase(doingWords(a)).replace(/`/gu, "");
};

/** A step as a row: what it said, or what it did (its verb, then the command or path in full). */
export interface StepRowWords {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly failed: boolean;
  readonly said: boolean;
}

const VERB: Record<string, readonly [string, string]> = { command: ["Running", "Ran"], file_change: ["Editing", "Edited"], tool_call: ["Using", "Used"] };

export const stepRow = (step: WorkStep): StepRowWords | undefined => {
  if (step.kind === "message") {
    const text = step.text.trim();
    if (text === "") return undefined;
    return { id: step.id, title: step.role === "assistant" ? text : `Told: ${text}`, failed: false, said: true };
  }
  const a = step.action;
  const summary = a.summary.trim();
  if (summary === "") return undefined;
  const [running, done] = VERB[a.kind] ?? ["", ""];
  const failed = a.failed ? (a.exitCode === undefined ? " · failed" : ` · failed, exit ${String(a.exitCode)}`) : "";
  if (a.kind === "file_change") return { id: step.id, title: `${a.status === "running" ? running : done} ${fileParts(summary).name}${failed}`, detail: summary, failed: a.failed, said: false };
  if (running === "") return { id: step.id, title: summary, failed: a.failed, said: false };
  return { id: step.id, title: `${a.status === "running" ? running : done}${failed}`, detail: summary, failed: a.failed, said: false };
};

/** A changed file as a row: its name, its folder, its lines. */
export const fileRow = (f: { path: string; additions: number; deletions: number }) => {
  const { name, dir } = fileParts(f.path);
  return { title: name, detail: dir === "" ? undefined : dir, value: changeStat(f.additions, f.deletions) || "binary" };
};

/** The agents a bot's Info lists under the working ones: those that ended in the last day, newest first, at most 5. */
export const recentlyEnded = (agents: readonly AgentRow[], nowMs: number): AgentRow[] =>
  agents
    .filter((a) => a.role !== "lead" && hasEnded(a) && a.taskId !== undefined && nowMs - Date.parse(a.endedAt ?? "") < 86_400_000)
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))
    .slice(0, 5);
