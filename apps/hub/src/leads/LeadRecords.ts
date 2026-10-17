import {
  Effort,
  Lead,
  Workstream,
  type AskId,
  type ProjectRef,
  type WorkstreamId,
  type WorkstreamState,
} from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as HubDb from "../store/HubDb.ts";

/** A lead as stored; its `state` is derived from the lead thread when read. */
export type StoredLead = Omit<Lead, "state">;

export interface LeadSettings {
  readonly model?: string;
  readonly effort?: Effort;
}

export interface StoredWorkstream {
  readonly workstream: Workstream;
  /** Human-answered asks already used to amend its brief; each authorizes one change. */
  readonly amends: ReadonlyArray<AskId>;
}

export const CLOSED_STATES: ReadonlyArray<WorkstreamState> = ["done", "stopped", "failed"];

export class LeadRecords extends Context.Service<
  LeadRecords,
  {
    readonly leads: {
      readonly get: (ref: ProjectRef) => Effect.Effect<StoredLead | undefined>;
      readonly put: (lead: StoredLead) => Effect.Effect<void>;
      readonly list: () => Effect.Effect<ReadonlyArray<StoredLead>>;
    };
    readonly settings: {
      readonly get: (ref: ProjectRef) => Effect.Effect<LeadSettings>;
      /** Absent fields fall back to the hub default. */
      readonly set: (ref: ProjectRef, settings: LeadSettings) => Effect.Effect<void>;
    };
    readonly workstreams: {
      /** Creates a draft. A repeated `clientRequestId` in the same project returns the first one with `created: false`. */
      readonly create: (input: {
        readonly ref: ProjectRef;
        readonly title: string;
        readonly source: Workstream["source"];
        readonly clientRequestId?: string;
      }) => Effect.Effect<{ readonly workstream: Workstream; readonly created: boolean }>;
      readonly get: (workstreamId: WorkstreamId) => Effect.Effect<StoredWorkstream | undefined>;
      readonly put: (stored: StoredWorkstream) => Effect.Effect<void>;
      /** Newest first. `open` keeps states other than done, stopped and failed. */
      readonly list: (filter: {
        readonly ref?: ProjectRef;
        readonly state?: WorkstreamState;
        readonly open?: boolean;
        readonly limit: number;
      }) => Effect.Effect<ReadonlyArray<Workstream>>;
    };
  }
>()("fleetd/leads/LeadRecords") {}

const StoredLeadJson = Lead.mapFields(Struct.omit(["state"]));
const decodeLead = Schema.decodeUnknownSync(StoredLeadJson);
const decodeWorkstream = Schema.decodeSync(Schema.fromJsonString(Workstream));
const encodeWorkstream = Schema.encodeSync(Schema.fromJsonString(Workstream));
const decodeEffort = Schema.decodeUnknownSync(Effort);
const decodeAmends = (json: string) => JSON.parse(json) as ReadonlyArray<AskId>;

const workstreamNumber = (id: WorkstreamId) => Number(id.slice(1));

const make = Effect.gen(function* () {
  const { db } = yield* HubDb.HubDb;

  const sql = {
    leadGet: db.prepare("SELECT * FROM leads WHERE machine_id = ? AND project_id = ?"),
    leadList: db.prepare("SELECT * FROM leads ORDER BY machine_id, project_id"),
    leadPut: db.prepare(
      `INSERT INTO leads (machine_id, project_id, thread_id, started_at, last_wake_at, session_generation)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (machine_id, project_id) DO UPDATE SET thread_id = excluded.thread_id, started_at = excluded.started_at,
         last_wake_at = excluded.last_wake_at, session_generation = excluded.session_generation`,
    ),
    settingsGet: db.prepare("SELECT model, effort FROM lead_settings WHERE machine_id = ? AND project_id = ?"),
    settingsSet: db.prepare(
      `INSERT INTO lead_settings (machine_id, project_id, model, effort) VALUES (?, ?, ?, ?)
       ON CONFLICT (machine_id, project_id) DO UPDATE SET model = excluded.model, effort = excluded.effort`,
    ),
    wsByRequest: db.prepare("SELECT data FROM workstreams WHERE machine_id = ? AND project_id = ? AND client_request_id = ?"),
    wsInsert: db.prepare(
      "INSERT INTO workstreams (machine_id, project_id, client_request_id, state, data) VALUES (?, ?, ?, 'draft', '') RETURNING n",
    ),
    wsGet: db.prepare("SELECT data, amends FROM workstreams WHERE n = ?"),
    wsPut: db.prepare("UPDATE workstreams SET state = ?, amends = ?, data = ? WHERE n = ?"),
    wsList: db.prepare(
      `SELECT data FROM workstreams
       WHERE ($machine IS NULL OR machine_id = $machine) AND ($project IS NULL OR project_id = $project)
         AND ($state IS NULL OR state = $state)
         AND ($open = 0 OR state NOT IN (SELECT value FROM json_each($closed)))
       ORDER BY n DESC LIMIT $limit`,
    ),
  };

  const leadOf = (row: Record<string, unknown>): StoredLead =>
    decodeLead({
      projectRef: { machineId: row.machine_id, projectId: row.project_id },
      threadId: row.thread_id,
      startedAt: row.started_at,
      ...(row.last_wake_at === null ? {} : { lastWakeAt: row.last_wake_at }),
      sessionGeneration: Number(row.session_generation),
    });

  return LeadRecords.of({
    leads: {
      get: (ref) =>
        Effect.sync(() => {
          const row = sql.leadGet.get(ref.machineId, ref.projectId);
          return row === undefined ? undefined : leadOf(row);
        }),
      put: (lead) =>
        Effect.sync(() => {
          sql.leadPut.run(
            lead.projectRef.machineId,
            lead.projectRef.projectId,
            lead.threadId,
            lead.startedAt,
            lead.lastWakeAt ?? null,
            lead.sessionGeneration,
          );
        }),
      list: () => Effect.sync(() => sql.leadList.all().map(leadOf)),
    },
    settings: {
      get: (ref) =>
        Effect.sync(() => {
          const row = sql.settingsGet.get(ref.machineId, ref.projectId);
          if (row === undefined) return {};
          return {
            ...(row.model === null ? {} : { model: String(row.model) }),
            ...(row.effort === null ? {} : { effort: decodeEffort(row.effort) }),
          };
        }),
      set: (ref, settings) =>
        Effect.sync(() => {
          sql.settingsSet.run(ref.machineId, ref.projectId, settings.model ?? null, settings.effort ?? null);
        }),
    },
    workstreams: {
      create: ({ ref, title, source, clientRequestId }) =>
        Effect.sync(() =>
          HubDb.transaction(db, () => {
            if (clientRequestId !== undefined) {
              const existing = sql.wsByRequest.get(ref.machineId, ref.projectId, clientRequestId);
              if (existing !== undefined) return { workstream: decodeWorkstream(String(existing.data)), created: false };
            }
            const n = Number(sql.wsInsert.get(ref.machineId, ref.projectId, clientRequestId ?? null)?.n);
            const workstream = Workstream.make({
              workstreamId: `W${n}` as WorkstreamId,
              projectRef: ref,
              title,
              source,
              state: "draft",
              createdAt: source.at,
              updatedAt: source.at,
            });
            sql.wsPut.run(workstream.state, "[]", encodeWorkstream(workstream), n);
            return { workstream, created: true };
          }),
        ),
      get: (workstreamId) =>
        Effect.sync(() => {
          const row = sql.wsGet.get(workstreamNumber(workstreamId));
          return row === undefined
            ? undefined
            : { workstream: decodeWorkstream(String(row.data)), amends: decodeAmends(String(row.amends)) };
        }),
      put: ({ workstream, amends }) =>
        Effect.sync(() => {
          sql.wsPut.run(workstream.state, JSON.stringify(amends), encodeWorkstream(workstream), workstreamNumber(workstream.workstreamId));
        }),
      list: (filter) =>
        Effect.sync(() =>
          sql.wsList
            .all({
              machine: filter.ref?.machineId ?? null,
              project: filter.ref?.projectId ?? null,
              state: filter.state ?? null,
              open: filter.open === true ? 1 : 0,
              closed: JSON.stringify(CLOSED_STATES),
              limit: filter.limit,
            })
            .map((row) => decodeWorkstream(String(row.data))),
        ),
    },
  });
});

export const layer = Layer.effect(LeadRecords, make);
