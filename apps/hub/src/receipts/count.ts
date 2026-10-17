// Receipts: what a task actually executed, counted from its T3 items rather than read from its prose. Pure.
import type { ActionItem, Receipts, TaskResult } from "@fleetd/contracts";

export const countReceipts = (actions: ReadonlyArray<ActionItem>): Receipts => {
  let commands = 0;
  let commandsFailed = 0;
  let toolCalls = 0;
  const files = new Set<string>();
  for (const a of actions) {
    if (a.kind === "command") {
      commands++;
      if (a.failed) commandsFailed++;
    } else if (a.kind === "file_change") {
      // Several edits to one file are one changed file.
      files.add(a.summary);
    } else if (a.kind === "tool_call") {
      toolCalls++;
    }
  }
  return { commands, commandsFailed, filesChanged: files.size, toolCalls };
};

/** The fixed claim phrases: "tests pass", "fixed", "ran", "verified", "all green", as whole words, any case. */
const CLAIM = /\b(?:tests? pass(?:es|ed|ing)?|fixed|ran|verified|all green)\b/iu;

/** The text claims something was run or checked, yet the task ran no commands. */
export const claimsUnverified = (text: string, receipts: Receipts): boolean => receipts.commands === 0 && CLAIM.test(text);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The wake's receipts line, or undefined for results stored before receipts existed. */
export const receiptsLine = (result: TaskResult): string | undefined => {
  const r = result.receipts;
  if (r === undefined) return undefined;
  if (result.claimsUnverified === true) return "receipts: 0 commands run — claims unverified";
  const commands = r.commands === 0 ? "0 commands run" : `${plural(r.commands, "command")} (${r.commandsFailed} failed)`;
  return `receipts: ${commands}, ${plural(r.filesChanged, "file")} changed, ${plural(r.toolCalls, "tool call")}`;
};
