// A repo's own train checks. A repo that commits `.fleetd/train.json`
// on its base sets them there: `fastChecks`, more checks the train waits for on each PR and batch, and `afterMerge`,
// checks that never stop a merge.
import type { Train } from "./service.ts";

export const PATH = ".fleetd/train.json";
/** How long a base's file is trusted before it is read again, as its CI config is. */
const TTL_MS = 10 * 60_000;
const TRAIN_CHECKS_MAX = 50;

/** The project's or repo's train settings (contracts `TrainSettings`). */
export type TrainSettings = { fastChecks: string[]; afterMerge: string[] };

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

/** The file's shape: the two lists, nothing else, so a misspelt key isn't a list that silently does nothing. */
export function parse(text: string): TrainSettings {
  const file = JSON.parse(text) as unknown;
  if (file === null || typeof file !== "object" || Array.isArray(file)) throw new Error("expected an object");
  for (const key of Object.keys(file)) {
    if (key !== "fastChecks" && key !== "afterMerge") throw new Error(`unknown field \`${key}\`, expected \`fastChecks\` or \`afterMerge\``);
  }
  const f = file as Record<string, unknown>;
  return { fastChecks: list(f.fastChecks, "fastChecks"), afterMerge: list(f.afterMerge, "afterMerge") };
}

/** The base's `.fleetd/train.json`, read at most every `TTL_MS`: empty settings without one; undefined when unusable. */
export async function repoChecks(t: Train, repo: string, base: string): Promise<TrainSettings | undefined> {
  const key = `${repo}\u0000${base}`;
  const now = t.nowMs();
  const cached = t.repoChecks.get(key);
  if (cached && now - cached[0] < TTL_MS) return cached[1];
  let settings: TrainSettings | undefined;
  try {
    const text = await t.github.file(repo, PATH, base);
    if (text === undefined) settings = { fastChecks: [], afterMerge: [] };
    else {
      try {
        settings = parse(text);
      } catch (why) {
        t.warnHourly([`train: ${PATH} is not used on ${repo} ${base}; every check counts`], (why as Error).message, `train: ${PATH} is not used on ${repo} ${base}; every check counts: ${(why as Error).message}`);
        settings = undefined;
      }
    }
  } catch (error) {
    t.warnHourly([`train: ${PATH} not read on ${repo} ${base}`], (error as Error).message, `train: ${PATH} not read on ${repo} ${base}: ${(error as Error).message}`);
    return undefined;
  }
  t.repoChecks.set(key, [now, settings]);
  return settings;
}
