// Incidents: what went wrong, recorded by the hub from what it observed (a false claim, an estimate miss, a polish
// loop, ...), never by an agent. Each one is stored and announced as `incident.recorded`.
import { Incident, type IncidentClass, type IncidentId, type ProjectRef, type WorkstreamId } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";

export type IncidentInput = Omit<Incident, "incidentId" | "at">;

export interface IncidentFilter {
  readonly projectRef?: ProjectRef;
  readonly workstreamId?: WorkstreamId;
  readonly class?: IncidentClass;
  /** Recorded at or after this instant (ms), and before `untilMs`. */
  readonly sinceMs?: number;
  readonly untilMs?: number;
  readonly limit: number;
}

export class Incidents extends Context.Service<
  Incidents,
  {
    /** Numbers (`I<n>`), stores and emits `incident.recorded`. Evidence lines are cut to fit the contract. */
    readonly record: (input: IncidentInput) => Effect.Effect<Incident>;
    readonly get: (incidentId: IncidentId) => Effect.Effect<Incident | undefined>;
    /** Newest first. */
    readonly list: (filter: IncidentFilter) => Effect.Effect<ReadonlyArray<Incident>>;
    /** How many match per class (no limit), most first; classes with none are left out. */
    readonly counts: (filter: Omit<IncidentFilter, "limit">) => Effect.Effect<ReadonlyArray<{ readonly class: IncidentClass; readonly count: number }>>;
  }
>()("fleetd/incidents/Incidents") {}

const decode = Schema.decodeSync(Schema.fromJsonString(Incident));
const encode = Schema.encodeSync(Schema.fromJsonString(Incident));

// `at` is always formatIso's fixed-width UTC form, so text order is time order.
const WHERE = `($machine IS NULL OR (machine_id = $machine AND project_id = $project))
  AND ($workstream IS NULL OR workstream_id = $workstream) AND ($class IS NULL OR class = $class)
  AND ($since IS NULL OR json_extract(data, '$.at') >= $since) AND ($until IS NULL OR json_extract(data, '$.at') < $until)`;

const line = (text: string) => {
  const flat = text.trim() === "" ? "(empty)" : text;
  return flat.length > 2000 ? `${flat.slice(0, 1999)}…` : flat;
};

export const make = Effect.gen(function* () {
  const { db } = yield* HubDb.HubDb;
  const events = yield* EventLog.EventLog;

  const sql = {
    insert: db.prepare("INSERT INTO incidents (class, machine_id, project_id, workstream_id, data) VALUES (?, ?, ?, ?, '') RETURNING n"),
    setData: db.prepare("UPDATE incidents SET data = ? WHERE n = ?"),
    get: db.prepare("SELECT data FROM incidents WHERE n = ?"),
    list: db.prepare(`SELECT data FROM incidents WHERE ${WHERE} ORDER BY n DESC LIMIT $limit`),
    counts: db.prepare(`SELECT class, COUNT(*) AS count FROM incidents WHERE ${WHERE} GROUP BY class ORDER BY count DESC, class`),
  };
  const params = (filter: Omit<IncidentFilter, "limit">) => ({
    machine: filter.projectRef?.machineId ?? null,
    project: filter.projectRef?.projectId ?? null,
    workstream: filter.workstreamId ?? null,
    class: filter.class ?? null,
    since: filter.sinceMs === undefined ? null : new Date(filter.sinceMs).toISOString(),
    until: filter.untilMs === undefined ? null : new Date(filter.untilMs).toISOString(),
  });

  const record: Incidents["Service"]["record"] = (input) =>
    Effect.gen(function* () {
      const at = DateTime.formatIso(yield* DateTime.now);
      const incident = yield* Effect.sync(() =>
        HubDb.transaction(db, () => {
          const ref = input.projectRef;
          const n = Number(sql.insert.get(input.class, ref.machineId, ref.projectId, input.workstreamId ?? null)?.n);
          const incident: Incident = {
            ...input,
            incidentId: `I${n}` as IncidentId,
            evidence: input.evidence.slice(0, 20).map(line),
            at,
          };
          sql.setData.run(encode(incident), n);
          return incident;
        }),
      );
      yield* events.append({
        at,
        type: "incident.recorded",
        machineId: incident.projectRef.machineId,
        projectId: incident.projectRef.projectId,
        summary: `${incident.incidentId} ${incident.class}${incident.workstreamId === undefined ? "" : ` on ${incident.workstreamId}`}: ${incident.evidence[0] ?? ""}`,
        data: {
          incidentId: incident.incidentId,
          class: incident.class,
          ...(incident.workstreamId === undefined ? {} : { workstreamId: incident.workstreamId }),
          ...(incident.taskId === undefined ? {} : { taskId: incident.taskId }),
        },
      });
      return incident;
    });

  const list: Incidents["Service"]["list"] = (filter) =>
    Effect.sync(() => sql.list.all({ ...params(filter), limit: filter.limit }).map((row) => decode(String(row.data))));

  const counts: Incidents["Service"]["counts"] = (filter) =>
    Effect.sync(() => sql.counts.all(params(filter)).map((row) => ({ class: String(row.class) as IncidentClass, count: Number(row.count) })));

  const get: Incidents["Service"]["get"] = (incidentId) =>
    Effect.sync(() => {
      const row = sql.get.get(Number(incidentId.slice(1)));
      return row === undefined ? undefined : decode(String(row.data));
    });

  return Incidents.of({ record, get, list, counts });
});

/** Needs HubDb and EventLog. */
export const layer = Layer.effect(Incidents, make);
