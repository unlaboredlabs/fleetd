// Factory metrics' hub area (crates/fleetd/src/hub/metrics/mod.rs): landed changes folded out of the event log, kept
// past its 30 days, and read as merged per day, order to merged, the person's minutes per merged PR and the share
// through fleetd, by calendar day in the viewer's zone. `weeks` is each project's last 7 days for its Status row.
import type { Database } from "bun:sqlite";
import * as compute from "./compute.ts";
import { merges } from "./store.ts";
import { repoProjects } from "./tools.ts";
import { addDays, dayStart, localDate } from "./zone.ts";

export { catchUp } from "./project.ts";

/** A project's last 7 calendar days: landed changes on its repos by every route, and the share the train landed. */
export type Week = { merged: number; throughFleetdPct?: number };

/** Each project's Week by "<machine>/<project>"; a project none of whose repos the metrics know is absent. */
export function weeks(c: Database, now: number, tz: string): Map<string, Week> {
  const first = addDays(localDate(now, tz), -6);
  const rows = merges(c, dayStart(first, tz), now);
  const repos = new Map<string, string[]>();
  for (const [repo, refs] of repoProjects(c)) {
    for (const key of refs) {
      const [m, p] = compute.pairOf(key);
      const k = `${m}/${p}`;
      let list = repos.get(k);
      if (!list) repos.set(k, (list = []));
      list.push(repo);
    }
  }
  const out = new Map<string, Week>();
  for (const [k, list] of repos) {
    const s = compute.Stats.of(rows.filter((r) => list.includes(r.repo)));
    const pct = s.pct();
    out.set(k, pct === undefined ? { merged: s.n() } : { merged: s.n(), throughFleetdPct: pct });
  }
  return out;
}
