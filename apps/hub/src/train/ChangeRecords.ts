// Changes, trains and reported bypasses in the hub database. Repos are keyed lowercased.
import { Change, type ChangeId, type ChangeState, type ProjectRef } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HubDb from "../store/HubDb.ts";

/** States a Change waits in, in its train's queue. */
export const QUEUED_STATES: ReadonlyArray<ChangeState> = ["queued", "reviewing", "ready"];
/** States of the Change the train is working on. */
export const HEAD_STATES: ReadonlyArray<ChangeState> = ["rebasing", "ci", "merging"];
/** No way back from these; a new enqueue of the PR makes a new Change. */
export const TERMINAL_STATES: ReadonlyArray<ChangeState> = ["merged", "refused", "abandoned"];

export interface TrainRow {
  readonly repo: string;
  readonly projectRef: ProjectRef;
  readonly frozen: boolean;
  /** Merges after this are checked for bypasses. */
  readonly watchSinceMs: number;
}

export class ChangeRecords extends Context.Service<
  ChangeRecords,
  {
    /** Numbers it (`X<n>`) and stores it at the back of its repo's train. */
    readonly create: (change: Omit<Change, "changeId">) => Effect.Effect<Change>;
    readonly put: (change: Change) => Effect.Effect<void>;
    readonly get: (changeId: ChangeId) => Effect.Effect<Change | undefined>;
    /** The newest Change of the PR that is not merged, refused or abandoned. */
    readonly openFor: (repo: string, prNumber: number) => Effect.Effect<Change | undefined>;
    /** The newest Change of the PR in any state. */
    readonly latestFor: (repo: string, prNumber: number) => Effect.Effect<Change | undefined>;
    /** The repo's Changes in these states, in train order. */
    readonly inTrain: (repo: string, states: ReadonlyArray<ChangeState>) => Effect.Effect<ReadonlyArray<Change>>;
    /** Moves it ahead of every other Change of its repo. */
    readonly toFront: (changeId: ChangeId) => Effect.Effect<void>;
    /** Newest first. */
    readonly list: (filter: {
      readonly projectRef?: ProjectRef;
      readonly repo?: string;
      readonly state?: ChangeState;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<Change>>;
    /** Creates the repo's train for `projectRef` if it has none; returns the train either way. */
    readonly ensureTrain: (repo: string, projectRef: ProjectRef, nowMs: number) => Effect.Effect<TrainRow>;
    readonly train: (repo: string) => Effect.Effect<TrainRow | undefined>;
    readonly trains: () => Effect.Effect<ReadonlyArray<TrainRow>>;
    readonly setFrozen: (repo: string, frozen: boolean) => Effect.Effect<void>;
    /** True the first time a PR is reported as merged outside the train. */
    readonly markBypass: (repo: string, prNumber: number) => Effect.Effect<boolean>;
  }
>()("fleetd/train/ChangeRecords") {}

const decode = Schema.decodeSync(Schema.fromJsonString(Change));
const encode = Schema.encodeSync(Schema.fromJsonString(Change));
const numberOf = (changeId: ChangeId) => Number(changeId.slice(1));

const toTrain = (row: Record<string, unknown>): TrainRow => ({
  repo: String(row.repo),
  projectRef: { machineId: String(row.machine_id), projectId: String(row.project_id) } as ProjectRef,
  frozen: Number(row.frozen) === 1,
  watchSinceMs: Number(row.watch_since_ms),
});

const make = Effect.gen(function* () {
  const { db } = yield* HubDb.HubDb;
  const sql = {
    insert: db.prepare(
      `INSERT INTO changes (repo, pr_number, state, machine_id, project_id, train_order, data)
       VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(train_order), 0) + 1 FROM changes WHERE repo = ?), '') RETURNING n`,
    ),
    put: db.prepare("UPDATE changes SET state = ?, data = ? WHERE n = ?"),
    get: db.prepare("SELECT data FROM changes WHERE n = ?"),
    latestFor: db.prepare("SELECT data, state FROM changes WHERE repo = ? AND pr_number = ? ORDER BY n DESC"),
    inRepo: db.prepare("SELECT data, state FROM changes WHERE repo = ? ORDER BY train_order, n"),
    toFront: db.prepare(
      "UPDATE changes SET train_order = (SELECT MIN(train_order) - 1 FROM changes WHERE repo = (SELECT repo FROM changes WHERE n = $n)) WHERE n = $n",
    ),
    list: db.prepare(
      `SELECT data FROM changes
       WHERE ($machine IS NULL OR (machine_id = $machine AND project_id = $project))
         AND ($repo IS NULL OR repo = $repo) AND ($state IS NULL OR state = $state)
       ORDER BY n DESC LIMIT $limit`,
    ),
    trainInsert: db.prepare("INSERT OR IGNORE INTO trains (repo, machine_id, project_id, watch_since_ms) VALUES (?, ?, ?, ?)"),
    train: db.prepare("SELECT * FROM trains WHERE repo = ?"),
    trains: db.prepare("SELECT * FROM trains ORDER BY repo"),
    setFrozen: db.prepare("UPDATE trains SET frozen = ? WHERE repo = ?"),
    bypass: db.prepare("INSERT OR IGNORE INTO train_bypasses (repo, pr_number) VALUES (?, ?)"),
  };

  const create: ChangeRecords["Service"]["create"] = (change) =>
    Effect.sync(() =>
      HubDb.transaction(db, () => {
        const repo = change.repo.toLowerCase();
        const ref = change.projectRef;
        const n = Number(sql.insert.get(repo, change.prNumber, change.state, ref.machineId, ref.projectId, repo)?.n);
        const stored: Change = { ...change, repo, changeId: `X${n}` as ChangeId };
        sql.put.run(stored.state, encode(stored), n);
        return stored;
      }),
    );

  const inTrain: ChangeRecords["Service"]["inTrain"] = (repo, states) =>
    Effect.sync(() =>
      sql.inRepo
        .all(repo.toLowerCase())
        .filter((row) => states.includes(String(row.state) as ChangeState))
        .map((row) => decode(String(row.data))),
    );

  const latest = (repo: string, prNumber: number, open: boolean) =>
    Effect.sync(() => {
      const row = sql.latestFor
        .all(repo.toLowerCase(), prNumber)
        .find((r) => !open || !TERMINAL_STATES.includes(String(r.state) as ChangeState));
      return row === undefined ? undefined : decode(String(row.data));
    });

  return ChangeRecords.of({
    create,
    put: (change) => Effect.sync(() => void sql.put.run(change.state, encode(change), numberOf(change.changeId))),
    get: (changeId) =>
      Effect.sync(() => {
        const row = sql.get.get(numberOf(changeId));
        return row === undefined ? undefined : decode(String(row.data));
      }),
    openFor: (repo, prNumber) => latest(repo, prNumber, true),
    latestFor: (repo, prNumber) => latest(repo, prNumber, false),
    inTrain,
    toFront: (changeId) => Effect.sync(() => void sql.toFront.run({ n: numberOf(changeId) })),
    list: (filter) =>
      Effect.sync(() =>
        sql.list
          .all({
            machine: filter.projectRef?.machineId ?? null,
            project: filter.projectRef?.projectId ?? null,
            repo: filter.repo?.toLowerCase() ?? null,
            state: filter.state ?? null,
            limit: filter.limit,
          })
          .map((row) => decode(String(row.data))),
      ),
    ensureTrain: (repo, projectRef, nowMs) =>
      Effect.sync(() => {
        const key = repo.toLowerCase();
        sql.trainInsert.run(key, projectRef.machineId, projectRef.projectId, nowMs);
        return toTrain(sql.train.get(key)!);
      }),
    train: (repo) =>
      Effect.sync(() => {
        const row = sql.train.get(repo.toLowerCase());
        return row === undefined ? undefined : toTrain(row);
      }),
    trains: () => Effect.sync(() => sql.trains.all().map(toTrain)),
    setFrozen: (repo, frozen) => Effect.sync(() => void sql.setFrozen.run(frozen ? 1 : 0, repo.toLowerCase())),
    markBypass: (repo, prNumber) => Effect.sync(() => Number(sql.bypass.run(repo.toLowerCase(), prNumber).changes) === 1),
  });
});

/** Needs HubDb. */
export const layer = Layer.effect(ChangeRecords, make);
