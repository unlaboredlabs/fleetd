// The lead digest's "Merge train" lines (and leads/hooks.rs `train_lines` and
// `unlanded`, which read them for the leads area): each train's head and queue, what merged since the lead's last
// wake, and what is parked with its author.
import type { ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { mergesOf } from "../project_lead/store.ts";
import * as repos from "../repos/store.ts";
import { backSince } from "./back.ts";
import { leadTrainLines, type TrainFacts } from "./digest_lines.ts";
import type { TrainHost } from "./host.ts";
import { HubHost } from "./hub_host.ts";
import { changeRecords } from "./index.ts";
import type { ChangeRecords } from "./records.ts";

export { leadTrainLines, type TrainFacts } from "./digest_lines.ts";

/**
 * Trains whose project passes `shown` and their 50 newest Changes; with `now`, when each parked one went back to its
 * author and its writer's state, for those left with no push.
 */
export function trainFacts(records: ChangeRecords, shown: (r: ProjectRef) => boolean, now?: Pick<TrainFacts, "nowMs" | "writer">): TrainFacts {
  const trains = records.trains().filter((t) => shown(t.projectRef));
  const changes = records
    .list({ limit: 200 })
    .filter((c) => shown(c.projectRef))
    .slice(0, 50);
  const facts: TrainFacts = { trains: trains.slice(0, 10).map((t) => records.trainState(t.repo)), changes };
  return now ? { ...facts, ...now, backSince: backSince(records, changes) } : facts;
}

/** A writer task's state in words, as the digest shows it beside a PR it left with no push. */
export function writerState(host: Pick<TrainHost, "task" | "waitingOn">, taskId: string): string | undefined {
  const task = host.task(taskId);
  if (!task) return undefined;
  switch (task.state) {
    case "done": {
      const wait = host.waitingOn?.(taskId);
      return `ended, waiting on ${wait ?? "nothing"}`;
    }
    case "cancelled":
      return "was cancelled";
    default:
      return `is ${task.state}`;
  }
}

/**
 * The digest's train lines for the project; undefined when it has no train and no Change, and people don't merge a
 * GitHub repo of it: the section is left out. Where people merge a bot with a GitHub repo, the section always says so,
 * before its first PR and when its repo's train is another bot's, so the lead never tells the human a PR merges by
 * itself; a bot with no GitHub repo has no PR to merge and carries no such line.
 */
export function trainDigest(hub: Hub, r: ProjectRef, since?: string): string[] | undefined {
  const host = new HubHost(hub);
  const now = { nowMs: hub.clock.now(), writer: (taskId: string) => writerState(host, taskId) };
  const facts = trainFacts(changeRecords(hub), (x) => x.machineId === r.machineId && x.projectId === r.projectId, now);
  const onGithub = facts.trains.length > 0 || facts.changes.length > 0 || repos.of(hub.db.conn, r).some((x) => x.repoKey?.startsWith("github.com/"));
  const peopleMerge = onGithub && mergesOf(hub.db.conn, r) === "people";
  if (facts.trains.length === 0 && facts.changes.length === 0 && !peopleMerge) return undefined;
  return leadTrainLines({ ...facts, peopleMerge }, since);
}

/** The workstream's PRs on the train that are not merged or abandoned, as `#<n> <state>`. */
export function trainUnlanded(hub: Hub, r: ProjectRef, workstreamId: string): string[] {
  return changeRecords(hub)
    .unlanded(r, workstreamId)
    .map((c) => `#${c.prNumber} ${c.state}`);
}
