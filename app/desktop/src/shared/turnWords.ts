// The words of the lead's turn line (renderer/screens/chat/activity.ts): what it does now in plain words (its live
// lane's activity), how long it has worked, and the line they make. Pure, so the phone app says the same (app/mobile, through its src/desktop.ts).
import type { Activity } from "./contracts";

/** The lane id of a project's lead, as the hub cuts it (80 UTF-16 units, whole characters). */
export const leadLaneId = (r: { readonly machineId: string; readonly projectId: string }): string => {
  let id = `lead:${r.machineId}/${r.projectId}`;
  while (id.length > 80) id = Array.from(id).slice(0, -1).join("");
  return id;
};

/** The lead's fleetd calls, by name or prefix, in plain words. */
const FLEETD_WORDS: readonly (readonly [string, string])[] = [
  ["plan", "planning"],
  ["brief", "briefing an agent"],
  ["decisions_record", "noting a decision"],
  ["decisions_search", "looking up decisions"],
  ["review_read", "reading review findings"],
  ["task_message", "messaging an agent"],
  ["steer_send", "messaging an agent"],
  ["change_", "moving a PR along"],
];

/** A file's name, in backticks: the line sets it as code, the voice of machine text. */
const fileName = (path: string): string => `\`${path.split("/").filter(Boolean).at(-1) ?? path}\``;

/** One activity in the lead's words: what it does, never a raw tool name or command; a file's name as code. */
export const doingWords = (a: Activity): string => {
  switch (a.kind) {
    case "read":
      return a.path !== undefined && a.path !== "" ? `reading ${fileName(a.path)}` : "searching the code";
    case "edit":
      return `editing ${fileName(a.path)}`;
    case "command":
      return "running a command";
    case "writing":
      return "writing";
    case "thinking":
      return "thinking";
    case "compacting":
      return "tidying its notes";
    case "retrying":
      return `retrying (${String(a.attempt)} of ${String(a.of)})`;
    case "web":
      return "reading the web";
    case "planning":
      return "planning";
    case "tool": {
      if (a.server === "fleetd") {
        return FLEETD_WORDS.find(([name]) => (name.endsWith("_") ? a.name.startsWith(name) : a.name === name))?.[1] ?? "checking with fleetd";
      }
      return "working";
    }
  }
};

/** "40s", "3m 40s", "1h 12m": elapsed time only, never an estimate. */
export const workedFor = (ms: number): string => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${String(s)}s`;
  if (s < 3600) return `${String(Math.floor(s / 60))}m ${String(s % 60)}s`;
  return `${String(Math.floor(s / 3600))}h ${String(Math.floor((s % 3600) / 60))}m`;
};

/**
 * The quiet line after the lead's reply. While its turn runs: how long it has worked, counting up, then what it does
 * ("Working for 1m 12s" and "planning · started 3 agents"). Once the turn is over: "Worked for 3m 40s". Undefined when
 * there is nothing to say. The count is apart from the words, so a screen reader isn't told every second.
 */
export const turnLine = (
  turn: { readonly since?: number | undefined; readonly until?: number | undefined },
  doing: string | undefined,
  nowMs: number,
): { readonly count?: string; readonly words?: string } | undefined => {
  const { since, until } = turn;
  if (doing === undefined) return since !== undefined && until !== undefined ? { words: `Worked for ${workedFor(until - since)}` } : undefined;
  if (since === undefined || until !== undefined) return { words: doing };
  const count = `Working for ${workedFor(nowMs - since)}`;
  // "working" is all the hub said: the count says it already.
  return doing === "working" ? { count } : { count, words: doing };
};

/** "thinking" as a line's first word: "Thinking". */
export const sentenceCase = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);
