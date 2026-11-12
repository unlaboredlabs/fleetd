// A repo's own train checks. A repo that commits `.fleetd/train.json`
// on its base sets them there: `fastChecks`, more checks the train waits for on each PR and batch, and `afterMerge`,
// checks that never stop a merge.
import type { Train } from "./service.ts";
import { parse, PATH, type TrainSettings } from "./settings.ts";

export { afterMergeOnly, type Cached, fastSet, parse, PATH, type TrainSettings } from "./settings.ts";

/** How long a base's file is trusted before it is read again, as its CI config is. */
const TTL_MS = 10 * 60_000;

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
