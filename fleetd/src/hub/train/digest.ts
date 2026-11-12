// The lead digest's "Merge train" lines (and leads/hooks.rs `train_lines` and
// `unlanded`, which read them for the leads area): each train's head and queue, what merged since the lead's last
// wake, and what is parked with its author.
import type { ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { leadTrainLines, type TrainFacts } from "./digest_lines.ts";
import { changeRecords } from "./index.ts";
import type { ChangeRecords } from "./records.ts";

export { leadTrainLines, type TrainFacts } from "./digest_lines.ts";

/** Trains whose project passes `shown` and their 50 newest Changes. */
export function trainFacts(records: ChangeRecords, shown: (r: ProjectRef) => boolean): TrainFacts {
  const trains = records.trains().filter((t) => shown(t.projectRef));
  const changes = records
    .list({ limit: 200 })
    .filter((c) => shown(c.projectRef))
    .slice(0, 50);
  return { trains: trains.slice(0, 10).map((t) => records.trainState(t.repo)), changes };
}

/** The digest's train lines for the project; undefined when it has no train and no Change: the section is left out. */
export function trainDigest(hub: Hub, r: ProjectRef, since?: string): string[] | undefined {
  const facts = trainFacts(changeRecords(hub), (x) => x.machineId === r.machineId && x.projectId === r.projectId);
  if (facts.trains.length === 0 && facts.changes.length === 0) return undefined;
  return leadTrainLines(facts, since);
}

/** The workstream's PRs on the train that are not merged or abandoned, as `#<n> <state>`. */
export function trainUnlanded(hub: Hub, r: ProjectRef, workstreamId: string): string[] {
  return changeRecords(hub)
    .unlanded(r, workstreamId)
    .map((c) => `#${c.prNumber} ${c.state}`);
}
