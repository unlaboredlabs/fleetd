// A repo's own train checks as its base's `.fleetd/train.json` sets them (repo_checks.ts reads the file): its shape and
// what the train waits for with it, and how many PRs it has in CI at once where they merge, then verify (`ciAtOnce`).

export const PATH = ".fleetd/train.json";
const TRAIN_CHECKS_MAX = 50;
/** PRs in CI at once in "Merge, then verify", when the file doesn't say: CI runners are scarce. */
export const CI_AT_ONCE = 4;
const CI_AT_ONCE_MAX = 16;

/** The repo's train settings; `ciAtOnce` absent: `CI_AT_ONCE`. */
export type TrainSettings = { fastChecks: string[]; afterMerge: string[]; ciAtOnce?: number };

/** A base's file and when it was read: empty settings when it has none, undefined when it can't be used. */
export type Cached = [number, TrainSettings | undefined];

/** The checks the train waits for on a head into a base that requires `required`. */
export function fastSet(s: TrainSettings, required: string[]): string[] {
  const out = [...required];
  for (const name of s.fastChecks) if (!out.includes(name) && !s.afterMerge.includes(name)) out.push(name);
  return out;
}

/** Whether a failure of `name`, a check outside the fast set, is left for after the merge. */
export const afterMergeOnly = (s: TrainSettings, name: string) => s.afterMerge.includes(name);

function list(v: unknown, key: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`${key}: expected a list of check names`);
  if (v.length > TRAIN_CHECKS_MAX) throw new Error(`${key}: at most ${TRAIN_CHECKS_MAX} checks`);
  const seen = new Set<string>();
  for (const name of v) {
    if (typeof name !== "string" || [...name].length < 1 || [...name].length > 200) throw new Error(`${key}: a check name is 1 to 200 characters`);
    if (seen.has(name)) throw new Error(`${key}: ${name} is there twice`);
    seen.add(name);
  }
  return v as string[];
}

const KEYS = ["fastChecks", "afterMerge", "ciAtOnce"];

/** The file's shape: the two lists and the number, nothing else, so a misspelt key isn't one that silently does nothing. */
export function parse(text: string): TrainSettings {
  const file = JSON.parse(text) as unknown;
  if (file === null || typeof file !== "object" || Array.isArray(file)) throw new Error("expected an object");
  for (const key of Object.keys(file)) {
    if (!KEYS.includes(key)) throw new Error(`unknown field \`${key}\`, expected \`fastChecks\`, \`afterMerge\` or \`ciAtOnce\``);
  }
  const f = file as Record<string, unknown>;
  const out: TrainSettings = { fastChecks: list(f.fastChecks, "fastChecks"), afterMerge: list(f.afterMerge, "afterMerge") };
  if (f.ciAtOnce !== undefined) {
    const n = f.ciAtOnce;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > CI_AT_ONCE_MAX) throw new Error(`ciAtOnce: a whole number from 1 to ${CI_AT_ONCE_MAX}`);
    out.ciAtOnce = n;
  }
  return out;
}

/** How many PRs the train has in CI at once in "Merge, then verify". */
export const ciAtOnce = (s: TrainSettings | undefined) => s?.ciAtOnce ?? CI_AT_ONCE;
