// Test helpers for the retro: playbook diffs written the way a model would, and its answers.
import fs from "node:fs";
import path from "node:path";
import type { PlaybookName } from "@fleetd/contracts";
import { bundledDir } from "../playbooks/load.ts";

export const bundled = (name: PlaybookName) => fs.readFileSync(path.join(bundledDir(), `${name}.md`), "utf8");

/** A one-hunk unified diff from `before` to `after`, with 3 lines of context and deliberately wrong line numbers. */
export const unifiedDiff = (name: string, before: string, after: string) => {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - 3);
  const toA = Math.min(a.length, endA + 3);
  const toB = Math.min(b.length, endB + 3);
  const lines = [
    `--- a/${name}.md`,
    `+++ b/${name}.md`,
    `@@ -${from + 7},${toA - from} +${from + 7},${toB - from} @@`,
    ...a.slice(from, start).map((l) => ` ${l}`),
    ...a.slice(start, endA).map((l) => `-${l}`),
    ...b.slice(start, endB).map((l) => `+${l}`),
    ...a.slice(endA, toA).map((l) => ` ${l}`),
  ];
  return `${lines.join("\n")}\n`;
};

/** `name`'s bundled file with `from` replaced by `to`, as a diff. */
export const edit = (name: PlaybookName, from: string, to: string) => {
  const before = bundled(name);
  if (!before.includes(from)) throw new Error(`${name}.md has no "${from}"`);
  return unifiedDiff(name, before, before.replace(from, to));
};

export const change = (over: Record<string, unknown> & { readonly diff: string }) => ({
  playbook: "bugfix",
  kind: "wording",
  fixesIncidents: ["I1"],
  metric: { class: "false_claim", op: "decrease", windowDays: 14 },
  expected: "fewer false done claims",
  ...over,
});

export const answer = (...changes: ReadonlyArray<unknown>) => JSON.stringify({ changes });

/** A wording change to bugfix's lead instructions. */
export const WORDING = edit("bugfix", "When the repro passes, claim done.", "Run the repro yourself before you claim done.");
/** A gate change: bugfix's M tier gets a verifier. */
export const GATE = edit("bugfix", "M: { reviewers: 1, verifier: false, planFirst: false }", "M: { reviewers: 1, verifier: true, planFirst: false }");
