import { Claim, type ClaimId, type ProjectRef, type WorkstreamId } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HubDb from "../store/HubDb.ts";

export class ClaimRecords extends Context.Service<
  ClaimRecords,
  {
    /** Numbers a claim (`C<n>`) as it starts. */
    readonly start: (workstreamId: WorkstreamId, ref: ProjectRef) => Effect.Effect<ClaimId>;
    /** Stores the finished claim under the id `start` gave it. */
    readonly finish: (claim: Claim) => Effect.Effect<void>;
    readonly get: (claimId: ClaimId) => Effect.Effect<Claim | undefined>;
    /** Finished claims, newest first. */
    readonly list: (filter: {
      readonly workstreamId?: WorkstreamId;
      readonly ref?: ProjectRef;
      readonly outcome?: Claim["outcome"];
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<Claim>>;
  }
>()("fleetd/checks/ClaimRecords") {}

const decodeClaim = Schema.decodeSync(Schema.fromJsonString(Claim));
const encodeClaim = Schema.encodeSync(Schema.fromJsonString(Claim));
const numberOf = (claimId: ClaimId) => Number(claimId.slice(1));

const make = Effect.gen(function* () {
  const { db } = yield* HubDb.HubDb;
  const sql = {
    insert: db.prepare("INSERT INTO claims (workstream_id, machine_id, project_id) VALUES (?, ?, ?) RETURNING n"),
    finish: db.prepare("UPDATE claims SET outcome = ?, data = ? WHERE n = ?"),
    get: db.prepare("SELECT data FROM claims WHERE n = ? AND data IS NOT NULL"),
    list: db.prepare(
      `SELECT data FROM claims
       WHERE data IS NOT NULL AND ($workstream IS NULL OR workstream_id = $workstream)
         AND ($machine IS NULL OR machine_id = $machine) AND ($project IS NULL OR project_id = $project)
         AND ($outcome IS NULL OR outcome = $outcome)
       ORDER BY n DESC LIMIT $limit`,
    ),
  };
  return ClaimRecords.of({
    start: (workstreamId, ref) =>
      Effect.sync(() => `C${Number(sql.insert.get(workstreamId, ref.machineId, ref.projectId)?.n)}` as ClaimId),
    finish: (claim) =>
      Effect.sync(() => {
        sql.finish.run(claim.outcome, encodeClaim(claim), numberOf(claim.claimId));
      }),
    get: (claimId) =>
      Effect.sync(() => {
        const row = sql.get.get(numberOf(claimId));
        return row === undefined ? undefined : decodeClaim(String(row.data));
      }),
    list: (filter) =>
      Effect.sync(() =>
        sql.list
          .all({
            workstream: filter.workstreamId ?? null,
            machine: filter.ref?.machineId ?? null,
            project: filter.ref?.projectId ?? null,
            outcome: filter.outcome ?? null,
            limit: filter.limit,
          })
          .map((row) => decodeClaim(String(row.data))),
      ),
  });
});

export const layer = Layer.effect(ClaimRecords, make);
