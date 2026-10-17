// Retro runs and proposals in the hub database. No logic beyond storage.
import {
  RetroProposal,
  RetroProposalId,
  RetroRun,
  type AskId,
  type IncidentClass,
  type MachineId,
  type RetroProposalState,
  type RetroTrigger,
} from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HubDb from "../store/HubDb.ts";

export interface StoredProposal {
  readonly proposal: RetroProposal;
  /** Machines of the incidents it cites: a key sees the proposal only with read on all of them. */
  readonly machines: ReadonlyArray<MachineId>;
  /** The override file a wording change replaced; null when the bundled playbook was in use. Undefined before it applies. */
  readonly previousOverride?: string | null;
}

/** States in which a proposal still holds its playbook: no other change to it may start. */
export const HOLDING: ReadonlyArray<RetroProposalState> = ["pending", "asked", "measuring"];

export class RetroRecords extends Context.Service<
  RetroRecords,
  {
    readonly runs: {
      /** Numbers a run as it starts. */
      readonly begin: (atMs: number, trigger: RetroTrigger, thresholdClass?: IncidentClass) => Effect.Effect<number>;
      readonly finish: (run: RetroRun, turned: boolean) => Effect.Effect<void>;
      readonly latest: () => Effect.Effect<RetroRun | undefined>;
      /** Start times of runs that spent a claude turn after `sinceMs`, oldest first. */
      readonly turnedSince: (sinceMs: number) => Effect.Effect<ReadonlyArray<number>>;
      /** A threshold run for `cls` started since `sinceMs`. */
      readonly thresholdSince: (cls: IncidentClass, sinceMs: number) => Effect.Effect<boolean>;
    };
    readonly proposals: {
      readonly insert: (proposal: Omit<RetroProposal, "proposalId">, machines: ReadonlyArray<MachineId>) => Effect.Effect<RetroProposal>;
      /** `previousOverride` is stored when given, kept otherwise. */
      readonly put: (proposal: RetroProposal, previousOverride?: string | null) => Effect.Effect<void>;
      readonly get: (id: RetroProposalId) => Effect.Effect<StoredProposal | undefined>;
      readonly byAsk: (askId: AskId) => Effect.Effect<StoredProposal | undefined>;
      /** Newest first. */
      readonly list: (filter: { readonly state?: RetroProposalState; readonly states?: ReadonlyArray<RetroProposalState>; readonly run?: number; readonly limit: number }) => Effect.Effect<ReadonlyArray<StoredProposal>>;
      /** Measuring proposals whose window ended by `nowMs`, oldest due first. */
      readonly due: (nowMs: number) => Effect.Effect<ReadonlyArray<StoredProposal>>;
      readonly nextDueMs: () => Effect.Effect<number | undefined>;
    };
  }
>()("fleetd/retro/RetroRecords") {}

const decodeProposal = Schema.decodeSync(Schema.fromJsonString(RetroProposal));
const encodeProposal = Schema.encodeSync(Schema.fromJsonString(RetroProposal));
const decodeRun = Schema.decodeSync(Schema.fromJsonString(RetroRun));
const encodeRun = Schema.encodeSync(Schema.fromJsonString(RetroRun));

const n = (id: string) => Number(id.slice(1));

export const make = Effect.gen(function* () {
  const { db } = yield* HubDb.HubDb;
  const sql = {
    runInsert: db.prepare("INSERT INTO retro_runs (at_ms, trigger, threshold_class, data) VALUES (?, ?, ?, '') RETURNING n"),
    runFinish: db.prepare("UPDATE retro_runs SET data = ?, turned = ? WHERE n = ?"),
    runLatest: db.prepare("SELECT data FROM retro_runs WHERE data != '' ORDER BY n DESC LIMIT 1"),
    runTurned: db.prepare("SELECT at_ms FROM retro_runs WHERE turned = 1 AND at_ms > ? ORDER BY at_ms"),
    runThreshold: db.prepare("SELECT 1 FROM retro_runs WHERE trigger = 'threshold' AND threshold_class = ? AND at_ms >= ? LIMIT 1"),
    insert: db.prepare("INSERT INTO retro_proposals (run_n, playbook, state, machines, data) VALUES (?, ?, ?, ?, '') RETURNING n"),
    put: db.prepare("UPDATE retro_proposals SET state = ?, ask_id = ?, due_ms = ?, data = ? WHERE n = ?"),
    putOverride: db.prepare("UPDATE retro_proposals SET had_override = ?, previous_override = ? WHERE n = ?"),
    get: db.prepare("SELECT * FROM retro_proposals WHERE n = ?"),
    byAsk: db.prepare("SELECT * FROM retro_proposals WHERE ask_id = ? ORDER BY n DESC LIMIT 1"),
    list: db.prepare(
      `SELECT * FROM retro_proposals WHERE ($states IS NULL OR state IN (SELECT value FROM json_each($states)))
         AND ($run IS NULL OR run_n = $run) ORDER BY n DESC LIMIT $limit`,
    ),
    due: db.prepare("SELECT * FROM retro_proposals WHERE state = 'measuring' AND due_ms <= ? ORDER BY due_ms, n"),
    nextDue: db.prepare("SELECT MIN(due_ms) AS due FROM retro_proposals WHERE state = 'measuring'"),
  };

  const stored = (row: Record<string, unknown>): StoredProposal => ({
    proposal: decodeProposal(String(row.data)),
    machines: JSON.parse(String(row.machines)) as Array<MachineId>,
    ...(row.had_override === null ? {} : { previousOverride: Number(row.had_override) === 1 ? String(row.previous_override) : null }),
  });

  return RetroRecords.of({
    runs: {
      begin: (atMs, trigger, thresholdClass) => Effect.sync(() => Number(sql.runInsert.get(atMs, trigger, thresholdClass ?? null)?.n)),
      finish: (run, turned) => Effect.sync(() => void sql.runFinish.run(encodeRun(run), turned ? 1 : 0, run.run)),
      latest: () =>
        Effect.sync(() => {
          const row = sql.runLatest.get();
          return row === undefined ? undefined : decodeRun(String(row.data));
        }),
      turnedSince: (sinceMs) => Effect.sync(() => sql.runTurned.all(sinceMs).map((row) => Number(row.at_ms))),
      thresholdSince: (cls, sinceMs) => Effect.sync(() => sql.runThreshold.get(cls, sinceMs) !== undefined),
    },
    proposals: {
      insert: (proposal, machines) =>
        Effect.sync(() =>
          HubDb.transaction(db, () => {
            const id = Number(sql.insert.get(proposal.run, proposal.playbook, proposal.state, JSON.stringify(machines))?.n);
            const full: RetroProposal = { proposalId: RetroProposalId.make(`R${id}`), ...proposal };
            sql.put.run(full.state, full.askId ?? null, null, encodeProposal(full), id);
            return full;
          }),
        ),
      put: (proposal, previousOverride) =>
        Effect.sync(() =>
          HubDb.transaction(db, () => {
            const dueMs = proposal.state === "measuring" && proposal.dueAt !== undefined ? Date.parse(proposal.dueAt) : null;
            sql.put.run(proposal.state, proposal.askId ?? null, dueMs, encodeProposal(proposal), n(proposal.proposalId));
            if (previousOverride !== undefined) sql.putOverride.run(previousOverride === null ? 0 : 1, previousOverride, n(proposal.proposalId));
          }),
        ),
      get: (id) =>
        Effect.sync(() => {
          const row = sql.get.get(n(id));
          return row === undefined ? undefined : stored(row);
        }),
      byAsk: (askId) =>
        Effect.sync(() => {
          const row = sql.byAsk.get(askId);
          return row === undefined ? undefined : stored(row);
        }),
      list: (filter) =>
        Effect.sync(() => {
          const states = filter.state !== undefined ? [filter.state] : filter.states;
          return sql.list.all({ states: states === undefined ? null : JSON.stringify(states), run: filter.run ?? null, limit: filter.limit }).map(stored);
        }),
      due: (nowMs) => Effect.sync(() => sql.due.all(nowMs).map(stored)),
      nextDueMs: () =>
        Effect.sync(() => {
          const due = sql.nextDue.get()?.due;
          return due === null || due === undefined ? undefined : Number(due);
        }),
    },
  });
});

/** Needs HubDb. */
export const layer = Layer.effect(RetroRecords, make);
