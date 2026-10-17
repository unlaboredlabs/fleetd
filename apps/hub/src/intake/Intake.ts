// Where a new intent goes. The caller's project, or a leading `@<project>`, decides the project; otherwise the router
// picks it, and when the router cannot, an unrouted ask lets the human pick. A template prefix (`fix:`) or the
// caller's template beats the router's; with the project known and no template given, it is `feature`.
import {
  DecisionKey,
  PlaybookName,
  ProjectRef,
  UNROUTED_ASK_PREFIX,
  type AskId,
  type Decision,
  type IntakeChannel,
  type IntakeEcho,
  type MachineId,
  type ProjectSummary,
  type WorkstreamId,
} from "@fleetd/contracts";
import crypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { LeadError } from "../leads/LeadError.ts";
import * as Workstreams from "../leads/Workstreams.ts";
import { Asks } from "../ledger/Asks.ts";
import { Decisions } from "../ledger/Decisions.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import { matchProject, parseIntent, refOf, slugOf } from "./prefix.ts";
import { IntakeRouter, type RouterRun } from "./Router.ts";

/** Projects offered to the router, most recently active first. */
export const ROUTER_PROJECTS = 20;
const RECENT_INTENTS = 3;
/** AskOptions holds at most 6. */
const ASK_OPTIONS = 6;
const DEFAULT_TEMPLATE: PlaybookName = "feature";

export interface SubmitInput {
  readonly text: string;
  readonly template?: PlaybookName;
  /** The caller named the project; then neither `@<project>` nor the router decides it. */
  readonly ref?: ProjectRef;
  readonly clientRequestId: string;
  readonly channel: IntakeChannel;
  /** An agent keyId, "human" or "lead:<machineId>/<projectId>". */
  readonly by: string;
  /** Whether the submitter may start work on this machine. */
  readonly allows: (machineId: MachineId) => boolean;
}

export type SubmitResult =
  | { readonly workstreamId: WorkstreamId; readonly echo: IntakeEcho; readonly next?: string }
  | { readonly askId: AskId; readonly next: string };

export class Intake extends Context.Service<Intake, { readonly submit: (input: SubmitInput) => Effect.Effect<SubmitResult, LeadError> }>()(
  "fleetd/intake/Intake",
) {}

/** One routed or asked-about intent; `options` maps the ask's options back to projects. */
const Route = Schema.Struct({
  text: Schema.String,
  template: Schema.optionalKey(PlaybookName),
  channel: Schema.Literals(["app", "phone", "mcp", "lead"]),
  by: Schema.String,
  options: Schema.optionalKey(Schema.Array(Schema.Struct({ label: Schema.String, ref: ProjectRef }))),
  workstreamId: Schema.optionalKey(Schema.String),
  echo: Schema.optionalKey(Schema.Struct({ projectRef: ProjectRef, template: PlaybookName, reason: Schema.String })),
});
type Route = typeof Route.Type;
const decodeRoute = Schema.decodeSync(Schema.fromJsonString(Route));
const encodeRoute = Schema.encodeSync(Schema.fromJsonString(Route));

const clip = (text: string, max: number) => {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** `intake.route.<words>-<hash>`: readable, and unique per request so two intents never share an ask. */
export const routeKey = (text: string, clientRequestId: string) => {
  const hash = crypto.createHash("sha256").update(clientRequestId).digest("hex").slice(0, 6);
  const words = slugOf(text).slice(0, 40).replace(/-+$/u, "");
  return DecisionKey.make(`${UNROUTED_ASK_PREFIX}${words === "" ? "" : `${words}-`}${hash}`);
};

/** Ask options: "<title> on <machine>", made unique with the project id when two read the same. */
const optionsOf = (projects: ReadonlyArray<ProjectSummary>) => {
  const seen = new Set<string>();
  return projects.slice(0, ASK_OPTIONS).map((p) => {
    let label = clip(`${p.title} on ${p.machineId}`, 200);
    if (seen.has(label.toLowerCase())) label = clip(`${p.title} on ${p.machineId} (${p.projectId})`, 200);
    seen.add(label.toLowerCase());
    return { label, ref: refOf(p) };
  });
};

export const make = Effect.gen(function* () {
  const { db } = yield* HubDb.HubDb;
  const store = yield* HubStore.HubStore;
  const events = yield* EventLog.EventLog;
  const workstreams = yield* Workstreams.Workstreams;
  const asks = yield* Asks;
  const decisions = yield* Decisions;
  const router = yield* IntakeRouter;

  const sql = {
    get: db.prepare("SELECT ask_id, data FROM intake_routes WHERE client_request_id = ?"),
    byAsk: db.prepare("SELECT client_request_id, data FROM intake_routes WHERE ask_id = ?"),
    put: db.prepare(
      `INSERT INTO intake_routes (client_request_id, ask_id, data) VALUES (?, ?, ?)
       ON CONFLICT (client_request_id) DO UPDATE SET data = excluded.data`,
    ),
  };
  const getRoute = (clientRequestId: string) =>
    Effect.sync(() => {
      const row = sql.get.get(clientRequestId);
      return row === undefined ? undefined : { askId: row.ask_id === null ? undefined : (String(row.ask_id) as AskId), route: decodeRoute(String(row.data)) };
    });
  const putRoute = (clientRequestId: string, askId: AskId | undefined, route: Route) =>
    Effect.sync(() => void sql.put.run(clientRequestId, askId ?? null, encodeRoute(route)));

  const routed = (input: {
    readonly echo?: IntakeEcho;
    readonly workstreamId?: WorkstreamId;
    readonly askId?: AskId;
    readonly summary: string;
    readonly runs?: ReadonlyArray<RouterRun>;
    readonly error?: string;
  }) =>
    Effect.gen(function* () {
      yield* events.append({
        at: DateTime.formatIso(yield* DateTime.now),
        type: "intake.routed",
        ...(input.echo === undefined ? {} : { machineId: input.echo.projectRef.machineId, projectId: input.echo.projectRef.projectId }),
        summary: input.summary,
        data: {
          ...(input.workstreamId === undefined ? {} : { workstreamId: input.workstreamId }),
          ...(input.askId === undefined ? {} : { askId: input.askId }),
          ...(input.echo === undefined ? {} : { template: input.echo.template, reason: input.echo.reason }),
          ...(input.error === undefined ? {} : { error: input.error }),
          // Each router run is orchestrator usage: what routing costs, apart from any project's work.
          ...(input.runs === undefined || input.runs.length === 0 ? {} : { usage: input.runs }),
        },
      });
    });

  /** Creates the workstream in the chosen project and reports where it went. */
  const place = (
    input: Pick<SubmitInput, "text" | "clientRequestId" | "channel" | "by">,
    echo: IntakeEcho,
    extra: { readonly runs?: ReadonlyArray<RouterRun>; readonly askId?: AskId } = {},
  ) =>
    Effect.gen(function* () {
      const created = yield* workstreams.intake({ ref: echo.projectRef, text: input.text, clientRequestId: input.clientRequestId, channel: input.channel, by: input.by });
      const project = (yield* store.projects.get(echo.projectRef))?.title ?? echo.projectRef.projectId;
      yield* routed({
        echo,
        workstreamId: created.workstreamId,
        ...extra,
        summary: clip(`${created.workstreamId} → ${project} (${echo.template}): ${echo.reason}`, 200),
      });
      return { workstreamId: created.workstreamId, echo, ...(created.next === undefined ? {} : { next: created.next }) };
    });

  const submit: Intake["Service"]["submit"] = (input) =>
    Effect.gen(function* () {
      const parsed = parseIntent(input.text);
      const fixedTemplate = input.template ?? parsed.template;
      const templateWhy =
        input.template !== undefined
          ? `template ${input.template} given by the caller`
          : parsed.prefix !== undefined
            ? `template ${parsed.template} from the ${parsed.prefix} prefix`
            : `template ${DEFAULT_TEMPLATE} by default`;
      if (input.ref !== undefined) {
        const echo = { projectRef: input.ref, template: fixedTemplate ?? DEFAULT_TEMPLATE, reason: clip(`project given by the caller; ${templateWhy}`, 200) };
        return yield* place(input, echo);
      }
      const allowed = (yield* store.projects.list()).filter((p) => input.allows(p.machineId));

      if (parsed.project !== undefined) {
        const match = matchProject(parsed.project, allowed);
        if (match.kind === "none") {
          return yield* new LeadError({
            code: "not_found",
            message: `No project you may start work in matches @${parsed.project}.`,
            fix: `Use a project's title or folder name (projects_list shows them)${allowed.length === 0 ? "" : `, e.g. @${slugOf(allowed[0]!.title)}`}.`,
          });
        }
        if (match.kind === "many") {
          return yield* new LeadError({
            code: "invalid",
            message: `@${parsed.project} matches ${match.projects.length} projects: ${match.projects.slice(0, 5).map((p) => `${p.title} on ${p.machineId}`).join(", ")}.`,
            fix: "Pass machineId and projectId instead (projects_list shows them).",
          });
        }
        const echo = {
          projectRef: refOf(match.project),
          template: fixedTemplate ?? DEFAULT_TEMPLATE,
          reason: clip(`@${parsed.project} names ${match.project.title}; ${templateWhy}`, 200),
        };
        return yield* place(input, echo);
      }

      // A retry of the same request returns what the first one got, without another router run.
      const earlier = yield* getRoute(input.clientRequestId);
      if (earlier?.route.workstreamId !== undefined && earlier.route.echo !== undefined) {
        return { workstreamId: earlier.route.workstreamId as WorkstreamId, echo: earlier.route.echo };
      }
      if (earlier?.askId !== undefined) return { askId: earlier.askId, next: `Answer ${earlier.askId} with inbox_reply to pick the project.` };

      if (allowed.length === 0) {
        return yield* new LeadError({
          code: "not_found",
          message: "There is no project you may start work in.",
          fix: "Open the project in T3 on a connected machine, or ask the hub admin for an operate grant.",
        });
      }
      const candidates = allowed.slice(0, ROUTER_PROJECTS);
      const projects = yield* Effect.forEach(candidates, (p) =>
        Effect.map(workstreams.list({ ref: refOf(p), limit: RECENT_INTENTS }), (recent) => ({
          ref: refOf(p),
          title: p.title,
          root: p.workspaceRoot,
          recentIntents: recent.map((w) => w.title),
        })),
      );
      const outcome = yield* router.route({ text: input.text, projects });
      const base = { text: input.text, ...(fixedTemplate === undefined ? {} : { template: fixedTemplate }), channel: input.channel, by: input.by };

      if (outcome.result !== undefined) {
        const reason = fixedTemplate === undefined || fixedTemplate === outcome.result.template ? outcome.result.reason : `${outcome.result.reason} (${templateWhy})`;
        const echo = { projectRef: outcome.result.projectRef, template: fixedTemplate ?? outcome.result.template, reason: clip(reason, 200) };
        const placed = yield* place(input, echo, { runs: outcome.runs });
        yield* putRoute(input.clientRequestId, undefined, { ...base, workstreamId: placed.workstreamId, echo });
        return placed;
      }

      const options = optionsOf(candidates);
      const why = outcome.why ?? "the router gave no answer";
      const filed = yield* asks
        .create(
          {
            kind: "decide",
            key: routeKey(input.text, input.clientRequestId),
            class: "product",
            text: clip(`Which project is this intent for? "${clip(input.text, 300)}" (${why})`, 500),
            options: options.map((o) => o.label),
            recommendation: options[0]!.label,
            blocks: "this intent until it has a project",
            proceededOnRec: false,
          },
          input.by,
        )
        .pipe(Effect.mapError((e) => new LeadError({ code: e.code, message: e.message, ...(e.fix === undefined ? {} : { fix: e.fix }) })));
      const askId = filed.ask.askId;
      yield* putRoute(input.clientRequestId, askId, { ...base, options });
      yield* routed({ askId, runs: outcome.runs, summary: clip(`${askId}: which project for "${input.text}"? ${why}`, 200) });
      return { askId, next: `The router could not place this intent (${why}). Answer ${askId} with inbox_reply to pick the project.` };
    });

  /** The human's answer to a routing ask: the option it names, or a project title or folder name. */
  const projectOfAnswer = (value: string, route: Route) =>
    Effect.gen(function* () {
      const wanted = value.trim().toLowerCase();
      const option = route.options?.find((o) => o.label.toLowerCase() === wanted);
      if (option !== undefined) return option.ref;
      const match = matchProject(value.trim().replace(/^@/u, ""), yield* store.projects.list());
      return match.kind === "one" ? refOf(match.project) : undefined;
    });

  const onAnswer = (decision: Decision) =>
    Effect.gen(function* () {
      const askId = decision.askId;
      if (askId === undefined) return;
      const row = sql.byAsk.get(askId);
      if (row === undefined) return;
      const clientRequestId = String(row.client_request_id);
      const route = decodeRoute(String(row.data));
      if (route.workstreamId !== undefined) return;
      const ref = yield* projectOfAnswer(decision.value, route);
      if (ref === undefined) {
        yield* routed({
          askId,
          error: `the answer "${clip(decision.value, 80)}" names no project`,
          summary: clip(`${askId}: the answer "${decision.value}" names no project; submit the intent again with @<project>`, 200),
        });
        return;
      }
      const echo = { projectRef: ref, template: route.template ?? DEFAULT_TEMPLATE, reason: clip(`the human picked it in ${askId}`, 200) };
      const placed = yield* Effect.result(place({ ...route, clientRequestId }, echo, { askId }));
      if (placed._tag === "Failure") {
        yield* routed({ askId, error: placed.failure.message, summary: clip(`${askId}: could not start the intent: ${placed.failure.message}`, 200) });
        return;
      }
      yield* putRoute(clientRequestId, askId, { ...route, workstreamId: placed.success.workstreamId, echo });
    });

  // Answers arrive through the inbox as decision.recorded events; follow them from the hub's start.
  let cursor = yield* events.head();
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        const page = yield* events.wait({ cursor, types: ["decision.recorded"], timeoutSec: 3600 });
        cursor = page.cursor;
        for (const event of page.events) {
          const data = event.data as { readonly key?: string; readonly decisionId?: Decision["decisionId"] } | undefined;
          if (data?.decisionId === undefined || !data.key?.startsWith(UNROUTED_ASK_PREFIX)) continue;
          const decision = yield* decisions.get(data.decisionId);
          if (decision !== undefined) yield* onAnswer(decision);
        }
      }),
    ),
  );

  return Intake.of({ submit });
});

export const layer = Layer.effect(Intake, make);
