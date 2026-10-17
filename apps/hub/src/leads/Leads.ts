// One lead per project: a T3 thread on the project's machine, started with the lead prompt plus the digest.
import type { Effort, Lead, LeadState, ProjectRef, ProjectSummary, ThreadSummary } from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Executors from "../executor/Executors.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import * as LeadRecords from "./LeadRecords.ts";
import { fromExecutor, LeadError } from "./LeadError.ts";
import * as LeadWakes from "./LeadWakes.ts";
import { LEAD_PROMPT_VERSION, readLeadPrompt, renderLeadPrompt } from "./prompt.ts";

export interface LeadsOptions {
  /** Hub-wide default model and effort; per-project settings override them. The lab sets haiku/low here. */
  readonly model?: string;
  readonly effort?: Effort;
  /** The prompt template; defaults to the current prompt-v<n>.md read from beside this module. */
  readonly prompt?: string;
}

export const DEFAULT_LEAD_MODEL = "claude-opus-5-5";
export const DEFAULT_LEAD_EFFORT: Effort = "high";

export class Leads extends Context.Service<
  Leads,
  {
    /** Launches the project's lead, or returns the one it already has. */
    readonly start: (ref: ProjectRef) => Effect.Effect<Lead, LeadError>;
    /** A fresh lead thread from the current digest; bumps `sessionGeneration`. The old thread stays in T3. */
    readonly restart: (ref: ProjectRef) => Effect.Effect<Lead, LeadError>;
    readonly get: (ref: ProjectRef) => Effect.Effect<Lead | undefined>;
    /** Per-project model and effort for the next start or restart. */
    readonly configure: (ref: ProjectRef, settings: LeadRecords.LeadSettings) => Effect.Effect<void>;
  }
>()("fleetd/leads/Leads") {}

/** The lead's state, read off its thread as the shell stream last reported it. */
export const leadState = (thread: ThreadSummary | undefined): LeadState => {
  if (thread === undefined) return "starting";
  switch (thread.status) {
    case "running":
      return "working";
    case "waiting":
    case "failed":
      return "stalled";
    default:
      return "idle";
  }
};

export const make = (options: LeadsOptions = {}) =>
  Effect.gen(function* () {
    const records = yield* LeadRecords.LeadRecords;
    const store = yield* HubStore.HubStore;
    const events = yield* EventLog.EventLog;
    const executors = yield* Executors.Executors;
    const wakes = yield* LeadWakes.LeadWakes;
    const template = options.prompt ?? readLeadPrompt();
    // Serializes start and restart, so two concurrent calls for one project launch one thread.
    const lock = Semaphore.makeUnsafe(1);

    const withState = (lead: LeadRecords.StoredLead) =>
      Effect.map(
        store.threads.get({ machineId: lead.projectRef.machineId, threadId: lead.threadId }),
        (thread): Lead => ({ ...lead, state: leadState(thread) }),
      );

    const projectOf = (ref: ProjectRef) =>
      Effect.flatMap(store.projects.get(ref), (project) =>
        project === undefined
          ? Effect.fail(
              new LeadError({
                code: "not_found",
                message: `No project ${ref.projectId} on machine ${ref.machineId}.`,
                fix: "Call projects_list for the known projects.",
              }),
            )
          : Effect.succeed(project),
      );

    const launch = (ref: ProjectRef, project: ProjectSummary, sessionGeneration: number) =>
      Effect.gen(function* () {
        const settings = yield* records.settings.get(ref);
        const model = settings.model ?? options.model ?? DEFAULT_LEAD_MODEL;
        const effort = settings.effort ?? options.effort ?? DEFAULT_LEAD_EFFORT;
        const prompt = `${renderLeadPrompt(template, { ref, title: project.title })}\n\n${yield* wakes.digest(ref)}`;
        const launchedMs = yield* Clock.currentTimeMillis;
        const { threadId } = yield* executors
          .launch(ref.machineId, {
            machineId: ref.machineId,
            projectId: ref.projectId,
            prompt,
            model,
            effort,
            runtimeMode: "full-access",
            title: `fleetd lead: ${project.title}`.slice(0, 80),
            // T3 keeps a receipt per command id forever, so the id names this launch: a hub started on a fresh
            // database must get a new thread, not the one an earlier hub launched for the same project.
            clientRequestId: `fleetd-lead:${ref.machineId}/${ref.projectId}:${sessionGeneration}:${launchedMs}`,
          })
          .pipe(Effect.mapError(fromExecutor));
        const at = DateTime.formatIso(yield* DateTime.now);
        const lead: LeadRecords.StoredLead = { projectRef: ref, threadId, startedAt: at, sessionGeneration };
        yield* records.leads.put(lead);
        yield* events.append({
          at,
          type: "lead.started",
          machineId: ref.machineId,
          projectId: ref.projectId,
          threadId,
          summary: `Lead of ${project.title} started (session ${sessionGeneration})`,
          data: { sessionGeneration, model, effort, prompt: LEAD_PROMPT_VERSION },
        });
        return yield* withState(lead);
      });

    const start: Leads["Service"]["start"] = (ref) =>
      Effect.gen(function* () {
        const existing = yield* records.leads.get(ref);
        if (existing !== undefined) return yield* withState(existing);
        return yield* launch(ref, yield* projectOf(ref), 0);
      }).pipe(lock.withPermit);

    const restart: Leads["Service"]["restart"] = (ref) =>
      Effect.gen(function* () {
        const existing = yield* records.leads.get(ref);
        if (existing === undefined) {
          return yield* new LeadError({
            code: "not_found",
            message: `Project ${ref.projectId} on ${ref.machineId} has no lead to restart.`,
            fix: "Call lead_start first.",
          });
        }
        return yield* launch(ref, yield* projectOf(ref), existing.sessionGeneration + 1);
      }).pipe(lock.withPermit);

    return Leads.of({
      start,
      restart,
      get: (ref) => Effect.flatMap(records.leads.get(ref), (lead) => (lead === undefined ? Effect.succeed(undefined) : withState(lead))),
      configure: records.settings.set,
    });
  });

export const layer = (options: LeadsOptions = {}) => Layer.effect(Leads, make(options));
