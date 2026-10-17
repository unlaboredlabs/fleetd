// The merge train in both digests: each train's state, PRs merged since the reader last looked, PRs sent back to
// their authors, and review waivers (the polish-loop rule's notes on a Change). The renderers are pure;
// `trainFacts` gathers their input.
import type { Change, ChangeState, TrainState } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as HubDb from "../store/HubDb.ts";
import { ChangeRecords, trainState } from "./ChangeRecords.ts";

export interface TrainFacts {
  readonly trains: ReadonlyArray<TrainState>;
  /** Newest first. */
  readonly changes: ReadonlyArray<Change>;
  /** Why review was waived for a Change's patch (M6's polish-loop rule, recorded by reviews/Reviews.ts). */
  readonly waivers: ReadonlyMap<string, string>;
}

const PARKED: ReadonlyArray<ChangeState> = ["needs_rebase", "ci_failed"];

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const short = (sha: string | undefined) => (sha === undefined ? "" : ` as ${sha.slice(0, 12)}`);
const pr = (c: Change) => `${c.repo}#${c.prNumber}`;
const by = (c: Change) => (c.taskId === undefined ? "" : `, by ${c.taskId}`);

const stateOf = (changes: ReadonlyArray<Change>, train: TrainState) => {
  const byId = new Map(changes.map((c) => [c.changeId as string, c]));
  const head = train.head === undefined ? undefined : byId.get(train.head);
  const queue = train.queue.map((id) => `${id}${byId.get(id) === undefined ? "" : ` ${byId.get(id)!.state}`}`);
  return [
    train.frozen ? "frozen" : "running",
    ...(train.head === undefined ? [] : [`now ${train.head}${head === undefined ? "" : ` (${head.state})`}`]),
    queue.length === 0 ? "queue empty" : `queue ${queue.slice(0, 8).join(", ")}${queue.length > 8 ? ` +${queue.length - 8}` : ""}`,
  ].join("; ");
};

const merged = (changes: ReadonlyArray<Change>, sinceMs: number | undefined) =>
  changes.filter((c) => c.state === "merged" && (sinceMs === undefined || Date.parse(c.updatedAt) > sinceMs));

/** Waived Changes still on the train, or merged since `sinceMs`. */
const waived = (facts: TrainFacts, sinceMs: number | undefined) =>
  facts.changes.flatMap((c) => {
    const reason = facts.waivers.get(c.changeId);
    const current = c.state !== "merged" || sinceMs === undefined || Date.parse(c.updatedAt) > sinceMs;
    return reason === undefined || !current ? [] : [{ c, reason }];
  });

/** The lead digest's "Merge train" lines. `since` is the lead's last wake. */
export const leadTrainLines = (facts: TrainFacts, since: string | undefined): ReadonlyArray<string> => {
  const sinceMs = since === undefined ? undefined : Date.parse(since);
  return [
    ...facts.trains.map((t) => `- ${t.repo}: ${stateOf(facts.changes, t)}`),
    ...merged(facts.changes, sinceMs).map((c) => `- ${c.changeId} merged${since === undefined ? "" : " since your last wake"}: ${pr(c)}${short(c.mergedSha)} (serves ${c.serves}${by(c)})`),
    ...facts.changes
      .filter((c) => PARKED.includes(c.state))
      .map((c) => `- ${c.changeId} ${c.state}: ${pr(c)}${by(c)}; ${oneLine(c.lastError ?? "", 160)}. The train told its author and retries the next push by itself.`),
    ...waived(facts, sinceMs).map(({ c, reason }) => `- ${c.changeId} ${pr(c)} (${c.state}): ${oneLine(reason, 200)}`),
  ];
};

/** The human digest's train lines: merges since the last digest, busy or frozen trains, PRs back with their authors, waivers. */
export const humanTrainLines = (facts: TrainFacts, sinceMs: number): ReadonlyArray<string> => [
  ...merged(facts.changes, sinceMs).map((c) => `Merged: ${pr(c)} (${c.changeId}, ${c.workstreamId}, tier ${c.tier})`),
  // An idle train says nothing the reader needs.
  ...facts.trains.filter((t) => t.frozen || t.head !== undefined || t.queue.length > 0).map((t) => `Train ${t.repo}: ${stateOf(facts.changes, t)}`),
  ...facts.changes.filter((c) => PARKED.includes(c.state)).map((c) => `Back with its author: ${pr(c)} (${c.changeId}) ${c.state}`),
  ...waived(facts, sinceMs).map(({ c, reason }) => `Waived: ${pr(c)} (${c.changeId}) ${oneLine(reason, 100)}`),
];

/** Trains whose project passes `shown` and their 50 newest Changes. */
export const trainFacts = (shown: (c: { readonly projectRef: Change["projectRef"] }) => boolean) =>
  Effect.gen(function* () {
    const records = yield* ChangeRecords;
    const { db } = yield* HubDb.HubDb;
    const trains = (yield* records.trains()).filter(shown);
    const changes = (yield* records.list({ limit: 200 })).filter(shown).slice(0, 50);
    const ids = new Set<string>(changes.map((c) => c.changeId));
    const waivers = new Map<string, string>();
    for (const row of db.prepare("SELECT change_id, reason FROM review_waivers ORDER BY rowid").all()) {
      if (ids.has(String(row.change_id))) waivers.set(String(row.change_id), String(row.reason));
    }
    return { trains: yield* Effect.forEach(trains.slice(0, 10), (t) => trainState(records, t.repo)), changes, waivers } satisfies TrainFacts;
  });
