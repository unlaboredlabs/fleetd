// Intake, brief freeze and status lines. A workstream's brief is frozen by hash when the lead registers it, and
// changes only with an ask the human answered.
import {
  Brief,
  type AskId,
  type BriefCreateResult,
  type IntakeChannel,
  type ProjectRef,
  type StatusSetResult,
  type Workstream,
  type WorkstreamId,
  type WorkstreamState,
} from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Asks } from "../ledger/Asks.ts";
import { Decisions } from "../ledger/Decisions.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import { briefHash } from "./brief.ts";
import * as LeadRecords from "./LeadRecords.ts";
import { LeadError } from "./LeadError.ts";
import * as LeadWakes from "./LeadWakes.ts";

export interface IntakeInput {
  readonly ref: ProjectRef;
  readonly text: string;
  readonly clientRequestId: string;
  readonly channel: IntakeChannel;
  /** An agent keyId, "human" or "lead:<machineId>/<projectId>". */
  readonly by: string;
}

export class Workstreams extends Context.Service<
  Workstreams,
  {
    /** Creates a draft workstream for the intent and wakes the lead. Idempotent per clientRequestId. */
    readonly intake: (input: IntakeInput) => Effect.Effect<{ readonly workstreamId: WorkstreamId; readonly next?: string }, LeadError>;
    /** `fleetd brief create` from the lead of `caller`. `brief` is validated here. */
    readonly briefCreate: (
      caller: ProjectRef,
      input: { readonly workstreamId: WorkstreamId; readonly brief: unknown; readonly amend?: AskId },
    ) => Effect.Effect<typeof BriefCreateResult.Type, LeadError>;
    /** `fleetd status set`. Without a workstream it needs exactly one open workstream in the project. */
    readonly statusSet: (
      caller: ProjectRef,
      input: { readonly text: string; readonly workstreamId?: WorkstreamId },
    ) => Effect.Effect<typeof StatusSetResult.Type, LeadError>;
    readonly get: (workstreamId: WorkstreamId) => Effect.Effect<Workstream | undefined>;
    /** Newest first. `open` keeps states other than done, stopped and failed. */
    readonly list: (filter: {
      readonly ref?: ProjectRef;
      readonly state?: WorkstreamState;
      readonly open?: boolean;
      readonly limit: number;
    }) => Effect.Effect<ReadonlyArray<Workstream>>;
  }
>()("fleetd/leads/Workstreams") {}

const decodeBrief = Schema.decodeUnknownEffect(Brief);

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

const titleOf = (text: string) => {
  const line = text.trim().split("\n", 1)[0]!.trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

export const make = Effect.gen(function* () {
  const records = yield* LeadRecords.LeadRecords;
  const store = yield* HubStore.HubStore;
  const events = yield* EventLog.EventLog;
  const wakes = yield* LeadWakes.LeadWakes;
  const asks = yield* Asks;
  const decisions = yield* Decisions;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  /** The caller's own workstream, or a refusal that says why. */
  const ownWorkstream = (caller: ProjectRef, workstreamId: WorkstreamId) =>
    Effect.gen(function* () {
      const stored = yield* records.workstreams.get(workstreamId);
      if (stored === undefined) {
        return yield* new LeadError({
          code: "not_found",
          message: `There is no workstream ${workstreamId}.`,
          fix: "Use a workstream id from the digest at the top of your last wake.",
        });
      }
      if (!sameProject(stored.workstream.projectRef, caller)) {
        return yield* new LeadError({
          code: "forbidden",
          message: `${workstreamId} belongs to another project.`,
          fix: "Use a workstream id from your own digest.",
        });
      }
      return stored;
    });

  const event = (w: Workstream, type: "workstream.created" | "workstream.running" | "workstream.state", summary: string, data?: unknown) =>
    events.append({
      at: w.updatedAt,
      type,
      machineId: w.projectRef.machineId,
      projectId: w.projectRef.projectId,
      summary,
      ...(data === undefined ? {} : { data }),
    });

  const intake: Workstreams["Service"]["intake"] = (input) =>
    Effect.gen(function* () {
      if ((yield* store.projects.get(input.ref)) === undefined) {
        return yield* new LeadError({
          code: "not_found",
          message: `No project ${input.ref.projectId} on machine ${input.ref.machineId}.`,
          fix: "Call projects_list for the known projects.",
        });
      }
      const { workstream, created } = yield* records.workstreams.create({
        ref: input.ref,
        title: titleOf(input.text),
        source: { text: input.text, channel: input.channel, by: input.by, at: yield* nowIso },
        clientRequestId: input.clientRequestId,
      });
      if (created) {
        yield* event(workstream, "workstream.created", `New intent ${workstream.workstreamId}: ${workstream.title}`);
        yield* wakes.trigger(input.ref, { kind: "intent", workstreamId: workstream.workstreamId, text: input.text });
      }
      const lead = yield* records.leads.get(input.ref);
      return {
        workstreamId: workstream.workstreamId,
        next:
          lead === undefined
            ? `${workstream.workstreamId} is a draft. The project has no lead yet; call lead_start and it will pick this up.`
            : `${workstream.workstreamId} is a draft; the lead registers its brief. Watch it with workstream_get.`,
      };
    });

  /** The amend ask must be one the human answered, for this project (and this workstream, if it names one), used once. */
  const checkAmend = (stored: LeadRecords.StoredWorkstream, askId: AskId) =>
    Effect.gen(function* () {
      const w = stored.workstream;
      const refuse = (message: string) =>
        new LeadError({
          code: "invalid",
          message,
          fix: `File \`fleetd ask --class product --key ${w.workstreamId.toLowerCase()}.brief --text "<the change and why>" --rec "<your proposal>" --workstream ${w.workstreamId}\` and rerun with --amend once the human answers it.`,
        });
      const ask = yield* asks.get(askId);
      if (ask === undefined || !sameProject(ask.projectRef, w.projectRef)) return yield* refuse(`There is no ask ${askId} in this project.`);
      if (ask.workstreamId !== undefined && ask.workstreamId !== w.workstreamId) {
        return yield* refuse(`${askId} is about ${ask.workstreamId}, not ${w.workstreamId}.`);
      }
      const decision = ask.decisionId === undefined ? undefined : yield* decisions.get(ask.decisionId);
      if (ask.state !== "answered" || decision?.source !== "human") return yield* refuse(`${askId} has no answer from the human yet.`);
      if (stored.amends.includes(askId)) return yield* refuse(`${askId} was already used to amend ${w.workstreamId}.`);
    });

  const briefCreate: Workstreams["Service"]["briefCreate"] = (caller, input) =>
    Effect.gen(function* () {
      const brief = yield* decodeBrief(input.brief).pipe(
        Effect.mapError(
          (error) =>
            new LeadError({
              code: "invalid",
              message: `Invalid brief: ${error.message}`.slice(0, 1000),
              fix: "A brief needs goal, why, pointers, constraints, at least one doneWhen check and a tier (S, M or L).",
            }),
        ),
      );
      const stored = yield* ownWorkstream(caller, input.workstreamId);
      const w = stored.workstream;
      if (LeadRecords.CLOSED_STATES.includes(w.state)) {
        return yield* new LeadError({ code: "invalid", message: `${w.workstreamId} is ${w.state}; its brief can no longer change.` });
      }
      const hash = briefHash(brief);
      const running = `Plan the work and report progress with \`fleetd status set "<one line>" --workstream ${w.workstreamId}\`.`;
      if (w.briefHash === hash) {
        return { op: "brief_create", workstreamId: w.workstreamId, briefHash: hash, state: w.state, next: `Unchanged: this brief is already frozen. ${running}` };
      }
      const at = yield* nowIso;
      if (w.brief === undefined) {
        const next: Workstream = { ...w, brief, briefHash: hash, state: "running", updatedAt: at };
        yield* records.workstreams.put({ workstream: next, amends: stored.amends });
        yield* event(next, "workstream.running", `${w.workstreamId} is running: ${w.title}`, { workstreamId: w.workstreamId, briefHash: hash });
        return { op: "brief_create", workstreamId: w.workstreamId, briefHash: hash, state: next.state, next: `Brief frozen. ${running}` };
      }
      if (input.amend === undefined) {
        return yield* new LeadError({
          code: "invalid",
          message: `The brief of ${w.workstreamId} is frozen; changing it needs an ask the human answered.`,
          fix: `File \`fleetd ask --class product --key ${w.workstreamId.toLowerCase()}.brief --text "<the change and why>" --rec "<your proposal>" --workstream ${w.workstreamId}\`, carry on meanwhile, and rerun with --amend <askId> once it is answered.`,
        });
      }
      yield* checkAmend(stored, input.amend);
      const next: Workstream = { ...w, brief, briefHash: hash, updatedAt: at };
      yield* records.workstreams.put({ workstream: next, amends: [...stored.amends, input.amend] });
      yield* event(next, "workstream.state", `${w.workstreamId} brief amended under ${input.amend}`, {
        workstreamId: w.workstreamId,
        state: next.state,
        briefHash: hash,
        amend: input.amend,
      });
      return { op: "brief_create", workstreamId: w.workstreamId, briefHash: hash, state: next.state, next: `Brief amended under ${input.amend}. ${running}` };
    });

  const statusSet: Workstreams["Service"]["statusSet"] = (caller, input) =>
    Effect.gen(function* () {
      let stored: LeadRecords.StoredWorkstream;
      if (input.workstreamId !== undefined) {
        stored = yield* ownWorkstream(caller, input.workstreamId);
      } else {
        const open = yield* records.workstreams.list({ ref: caller, open: true, limit: 2 });
        if (open.length !== 1) {
          return yield* new LeadError({
            code: "invalid",
            message: open.length === 0 ? "Your project has no open workstream." : "Your project has several open workstreams.",
            fix: "Pass --workstream W<n> with an id from your digest.",
          });
        }
        stored = yield* ownWorkstream(caller, open[0]!.workstreamId);
      }
      const at = yield* nowIso;
      const headline = input.text.replace(/\s+/gu, " ").trim().slice(0, 280);
      yield* records.workstreams.put({ ...stored, workstream: { ...stored.workstream, headline, headlineAt: at, updatedAt: at } });
      return { op: "status_set", workstreamId: stored.workstream.workstreamId, next: "Status recorded. Carry on." };
    });

  return Workstreams.of({
    intake,
    briefCreate,
    statusSet,
    get: (id) => Effect.map(records.workstreams.get(id), (s) => s?.workstream),
    list: records.workstreams.list,
  });
});

export const layer = Layer.effect(Workstreams, make);
