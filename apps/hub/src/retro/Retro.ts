// The retro: fleetd improving its playbooks from evidence without moving goalposts. One `claude -p` turn reads the
// window's incidents and the current playbooks and proposes changes; the hub validates each and classifies it by
// the fields it touches. Wording changes apply as a new override file and are measured over their window against
// the window before: kept when their metric went down and no guarded metric went up, reverted otherwise. Gate
// changes go to a person as one batch of asks each Monday. Nothing applies until the global Decision
// `policy.retro.apply` is true; until then every proposal is only "suggested".
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  DecisionKey,
  PLAYBOOK_ASK_PREFIX,
  PlaybookName,
  RetroMetricClass,
  type AskId,
  type Decision,
  type DecisionId,
  type HubEvent,
  type Incident,
  type IncidentClass,
  type RetroProposal,
  type RetroRun,
  type RetroTrigger,
} from "@fleetd/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { hubZone, isZone, POLICY_TZ_KEY } from "../digests/HumanDigests.ts";
import { Incidents } from "../incidents/Incidents.ts";
import { makeOneShot, type OneShotResult, type RouterOptions } from "../intake/Router.ts";
import { Asks } from "../ledger/Asks.ts";
import { Decisions } from "../ledger/Decisions.ts";
import { Playbooks } from "../playbooks/Playbooks.ts";
import * as EventLog from "../store/EventLog.ts";
import { nextCron, parseCron } from "../wakes/schedule.ts";
import { applyUnifiedDiff } from "./diff.ts";
import { DAY_MS, judge, makeMetrics } from "./metrics.ts";
import { HOLDING, RetroRecords, type StoredProposal } from "./RetroRecords.ts";
import { validateAnswer } from "./validate.ts";

/** The global Decision that lets the retro apply changes; anything but "true" keeps it advise-only. */
export const APPLY_KEY = "policy.retro.apply";
/** Runs that spend a claude turn, per rolling 24 h. */
export const RUNS_PER_DAY = 2;
export const DEFAULT_WINDOW_DAYS = 14;
/** A retro starts when this many incidents of one class land within THRESHOLD_DAYS. */
export const THRESHOLD = 3;
export const THRESHOLD_DAYS = 7;
const WEEKLY = parseCron("0 9 * * 1");
// Under the HTTP server's 5-minute request timeout, so retro_run answers before its call is cut off.
const RUN_TIMEOUT_MS = 240_000;
const PROMPT_INCIDENTS = 200;

export class RetroRefused extends Schema.TaggedError<RetroRefused>()("RetroRefused", {
  message: Schema.String,
  fix: Schema.String,
}) {}

/** The one `claude -p` turn of a run. */
export class RetroRunner extends Context.Service<RetroRunner, { readonly ask: (prompt: string) => Effect.Effect<OneShotResult> }>()(
  "fleetd/retro/RetroRunner",
) {}

/** The router's isolated runner (its config dir, environment allowlist and model), with a longer timeout. */
export const layerRunner = (options: RouterOptions) =>
  Layer.effect(RetroRunner, Effect.map(makeOneShot({ ...options, timeoutMs: RUN_TIMEOUT_MS }), (ask) => RetroRunner.of({ ask })));

export interface RunInput {
  readonly windowDays: number;
  /** Propose only, whatever policy.retro.apply says. */
  readonly advise?: boolean;
  readonly trigger: RetroTrigger;
  readonly thresholdClass?: IncidentClass;
}

export class Retro extends Context.Service<
  Retro,
  {
    readonly run: (input: RunInput) => Effect.Effect<{ readonly run: RetroRun; readonly proposals: ReadonlyArray<RetroProposal> }, RetroRefused>;
    /** Newest first; with the machines of the incidents each cites. */
    readonly proposals: (filter: { readonly state?: RetroProposal["state"]; readonly limit: number }) => Effect.Effect<ReadonlyArray<StoredProposal>>;
    readonly lastRun: () => Effect.Effect<RetroRun | undefined>;
    readonly applyEnabled: () => Effect.Effect<boolean>;
    /** Measures every wording change whose window has ended; keeps or reverts each. */
    readonly evaluateDue: () => Effect.Effect<ReadonlyArray<RetroProposal>>;
    /** Files one ask per pending gate change, all in the same batch; acts on answers already in the log. */
    readonly fileGateAsks: () => Effect.Effect<ReadonlyArray<RetroProposal>>;
  }
>()("fleetd/retro/Retro") {}

/** Read from beside this module: the source tree, or the CLI bundle's dist, where its build copies it. */
export const readRetroPrompt = () => fs.readFileSync(new URL("./retro-prompt.md", import.meta.url), "utf8");

export const renderRetroPrompt = (
  template: string,
  input: { readonly windowDays: number; readonly metrics: ReadonlyArray<string>; readonly incidents: ReadonlyArray<Incident>; readonly playbooks: ReadonlyMap<string, string> },
) =>
  template
    .replace("{{windowDays}}", String(input.windowDays))
    .replace("{{metrics}}", input.metrics.join(", "))
    .replace(
      "{{incidents}}",
      input.incidents.length === 0
        ? "(none)"
        : input.incidents
            .map((i) =>
              JSON.stringify({ id: i.incidentId, class: i.class, at: i.at, ...(i.workstreamId === undefined ? {} : { workstream: i.workstreamId }), evidence: i.evidence.slice(0, 3) }),
            )
            .join("\n"),
    )
    .replace("{{playbooks}}", [...input.playbooks].map(([name, text]) => `=== ${name}.md ===\n${text.trimEnd()}\n=== end ${name}.md ===`).join("\n\n"));

const iso = (ms: number) => new Date(ms).toISOString();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const unique = <A>(items: ReadonlyArray<A>) => [...new Set(items)];

export const gateAskKey = (proposal: RetroProposal) =>
  DecisionKey.make(`${PLAYBOOK_ASK_PREFIX}${proposal.playbook}.${createHash("sha256").update(proposal.diff).digest("hex").slice(0, 10)}`);

export const make = Effect.gen(function* () {
  const records = yield* RetroRecords;
  const incidents = yield* Incidents;
  const playbooks = yield* Playbooks;
  const decisions = yield* Decisions;
  const asks = yield* Asks;
  const events = yield* EventLog.EventLog;
  const runner = yield* RetroRunner;
  const metrics = yield* makeMetrics;
  const template = readRetroPrompt();
  const lock = Semaphore.makeUnsafe(1);
  // Threshold checks one at a time, so two incidents landing together start one run, not two.
  const thresholdLock = Semaphore.makeUnsafe(1);

  const globalValue = (key: string) =>
    Effect.map(decisions.list({ scope: { kind: "global" }, limit: 500 }), (all) => all.find((d) => d.key === key)?.value.trim());

  const applyEnabled = () => Effect.map(globalValue(APPLY_KEY), (value) => value?.toLowerCase() === "true");
  const zone = Effect.map(globalValue(POLICY_TZ_KEY), (tz) => (tz !== undefined && isZone(tz) ? tz : hubZone()));

  const emit = (type: HubEvent["type"], summary: string, data: Record<string, unknown>) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => events.append({ at: iso(now), type, summary, data }));

  /** Writes `text` as the playbook's override and records what it replaced. */
  const applyText = (proposal: RetroProposal, text: string, now: number) =>
    Effect.gen(function* () {
      const previousOverride = (yield* playbooks.override(proposal.playbook)) ?? null;
      const previousRef = playbooks.current(proposal.playbook).ref;
      const loaded = yield* Effect.result(playbooks.setOverride(proposal.playbook, text));
      if (loaded._tag === "Failure") {
        const stale: RetroProposal = { ...proposal, state: "stale", note: clip(loaded.failure.message, 500) };
        yield* records.proposals.put(stale);
        return stale;
      }
      const measuring = proposal.kind === "wording";
      const windowMs = proposal.metric.windowDays * DAY_MS;
      const applied: RetroProposal = {
        ...proposal,
        state: measuring ? "measuring" : "applied",
        ref: loaded.success.ref,
        previousRef,
        appliedAt: iso(now),
        ...(measuring
          ? { dueAt: iso(now + windowMs), baseline: yield* metrics.snapshot(proposal.playbook, proposal.metric.class, now - windowMs, now) }
          : {}),
      };
      yield* records.proposals.put(applied, previousOverride);
      yield* emit("playbook.changed", `${proposal.proposalId}: ${proposal.playbook} ${proposal.kind} change applied (${proposal.fields.join(", ")})`, {
        proposalId: proposal.proposalId,
        playbook: proposal.playbook,
        kind: proposal.kind,
        ref: applied.ref,
        previousRef,
        metric: proposal.metric,
        ...(applied.baseline === undefined ? {} : { baseline: applied.baseline, dueAt: applied.dueAt }),
      });
      return applied;
    });

  /** A gate change's diff, applied to the playbook as it is now. */
  const applyGate = (proposal: RetroProposal, now: number) =>
    Effect.gen(function* () {
      const patched = applyUnifiedDiff(playbooks.current(proposal.playbook).text, proposal.diff);
      if ("error" in patched) {
        const stale: RetroProposal = { ...proposal, state: "stale", note: clip(`approved, but ${patched.error}`, 500) };
        yield* records.proposals.put(stale);
        return stale;
      }
      return yield* applyText(proposal, patched.text, now);
    });

  /** A person's answer to a gate ask: "apply" applies it; anything else, or a withdrawal, rejects it. */
  const onGateAnswer = (stored: StoredProposal, decision: Decision | undefined, withdrawn: boolean) =>
    Effect.gen(function* () {
      const proposal = stored.proposal;
      if (proposal.state !== "asked") return proposal;
      const now = yield* Clock.currentTimeMillis;
      if (!withdrawn && decision?.value.trim().toLowerCase() === "apply") return yield* applyGate(proposal, now);
      const rejected: RetroProposal = { ...proposal, state: "rejected", note: withdrawn ? "the ask was withdrawn" : clip(`answered "${decision?.value ?? ""}"`, 500) };
      yield* records.proposals.put(rejected);
      return rejected;
    });

  /** Catches up on gate asks answered or withdrawn while nothing was listening. */
  const settleAsks = Effect.gen(function* () {
    for (const stored of yield* records.proposals.list({ state: "asked", limit: 100 })) {
      const ask = stored.proposal.askId === undefined ? undefined : yield* asks.get(stored.proposal.askId);
      if (ask === undefined || ask.state === "open") continue;
      const decision = ask.decisionId === undefined ? undefined : yield* decisions.get(ask.decisionId);
      yield* onGateAnswer(stored, decision, ask.state === "withdrawn");
    }
  });

  const run: Retro["Service"]["run"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const turned = yield* records.runs.turnedSince(now - DAY_MS);
        if (turned.length >= RUNS_PER_DAY) {
          return yield* new RetroRefused({
            message: `${turned.length} retro runs already spent a claude turn in the last 24 h; the budget is ${RUNS_PER_DAY} a day.`,
            fix: `Run it again from ${iso(turned[0]! + DAY_MS)}.`,
          });
        }
        const advise = input.advise === true || !(yield* applyEnabled());
        yield* settleAsks;
        const n = yield* records.runs.begin(now, input.trigger, input.thresholdClass);
        const windowIncidents = yield* incidents.list({ sinceMs: now - input.windowDays * DAY_MS, limit: PROMPT_INCIDENTS });
        const base = { run: n, at: iso(now), trigger: input.trigger, advise, windowDays: input.windowDays, incidents: windowIncidents.length };

        if (windowIncidents.length === 0) {
          const quiet: RetroRun = { ...base, proposals: [], dropped: [] };
          yield* records.runs.finish(quiet, false);
          yield* emit("retro.ran", `retro run ${n}: no incidents in ${input.windowDays} d, nothing to propose`, { run: n, trigger: input.trigger, advise, proposals: [] });
          return { run: quiet, proposals: [] };
        }

        const texts = new Map(PlaybookName.literals.map((name) => [name, playbooks.current(name).text] as const));
        const busy = new Map(
          (yield* records.proposals.list({ states: HOLDING, limit: 100 })).map(({ proposal: p }) => [p.playbook, `${p.proposalId} on ${p.playbook} is still ${p.state}`] as const),
        );
        const prompt = renderRetroPrompt(template, {
          windowDays: input.windowDays,
          metrics: RetroMetricClass.literals,
          incidents: windowIncidents,
          playbooks: texts,
        });
        const answer = yield* runner.ask(prompt);
        const checked =
          answer.text === undefined
            ? { error: answer.run.error ?? "the run gave no answer" }
            : validateAnswer(answer.text, { windowDays: input.windowDays, incidents: new Set(windowIncidents.map((i) => i.incidentId)), playbooks: texts, busy });
        const usage = "error" in checked ? { ...answer.run, ok: false, error: clip(checked.error, 300) } : answer.run;
        const accepted = "error" in checked ? [] : checked.accepted;
        const dropped = "error" in checked ? [] : checked.dropped;
        if ("error" in checked) yield* Effect.logWarning("retro: no usable answer", { run: n, error: checked.error });
        for (const d of dropped) yield* Effect.logWarning("retro: dropped a proposed change", { run: n, index: d.index, playbook: d.playbook, reason: d.reason });

        const byId = new Map(windowIncidents.map((i) => [i.incidentId as string, i]));
        const proposals: Array<RetroProposal> = [];
        for (const a of accepted) {
          const machines = unique(a.change.fixesIncidents.map((id) => byId.get(id)!.projectRef.machineId));
          const kind = a.kind;
          const inserted = yield* records.proposals.insert(
            {
              run: n,
              at: iso(now),
              playbook: a.change.playbook,
              kind,
              claimedKind: a.change.kind,
              diff: a.change.diff,
              fields: a.fields,
              fixesIncidents: a.change.fixesIncidents,
              metric: a.change.metric,
              expected: a.change.expected,
              state: advise ? "suggested" : "pending",
              ...(a.change.kind === kind ? {} : { note: `the model called it ${a.change.kind}; it changes ${a.fields.join(", ")}, so it is a ${kind} change` }),
            },
            machines,
          );
          proposals.push(!advise && kind === "wording" ? yield* applyText(inserted, a.after, now) : inserted);
        }

        const done: RetroRun = { ...base, proposals: proposals.map((p) => p.proposalId), dropped: dropped.map((d) => ({ index: d.index, ...(d.playbook === undefined ? {} : { playbook: clip(d.playbook, 40) }), reason: clip(d.reason, 500) })), usage };
        yield* records.runs.finish(done, true);
        yield* emit(
          "retro.ran",
          `retro run ${n}: ${proposals.length} change${proposals.length === 1 ? "" : "s"} ${advise ? "suggested" : "proposed"}, ${dropped.length} dropped`,
          { run: n, trigger: input.trigger, advise, proposals: done.proposals, dropped: dropped.length, usage: [usage] },
        );
        return { run: done, proposals };
      }),
    );

  const evaluateDue: Retro["Service"]["evaluateDue"] = () =>
    lock.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const out: Array<RetroProposal> = [];
        for (const stored of yield* records.proposals.due(now)) {
          const p = stored.proposal;
          const from = Date.parse(p.appliedAt!);
          const measured = yield* metrics.snapshot(p.playbook, p.metric.class, from, Date.parse(p.dueAt!));
          const verdict = judge(p.baseline!, measured);
          if (verdict.kept) {
            const kept: RetroProposal = { ...p, state: "kept", measured };
            yield* records.proposals.put(kept);
            yield* emit("playbook.kept", `${p.proposalId}: ${p.playbook} wording change kept; ${p.metric.class} ${p.baseline!.target} → ${measured.target}`, {
              proposalId: p.proposalId,
              playbook: p.playbook,
              ref: p.ref,
              baseline: p.baseline,
              measured,
            });
            out.push(kept);
            continue;
          }
          // Only the file this change wrote is rolled back; a playbook edited since is left to whoever edited it.
          const untouched = playbooks.current(p.playbook).ref === p.ref;
          const restored = untouched ? yield* Effect.result(playbooks.setOverride(p.playbook, stored.previousOverride ?? undefined)) : undefined;
          const note = clip(
            `${verdict.reason}${untouched ? (restored?._tag === "Failure" ? `; restoring the previous file failed: ${restored.failure.message}` : "") : "; the playbook changed since, so the file was left as it is"}`,
            500,
          );
          const reverted: RetroProposal = { ...p, state: "reverted", measured, note };
          yield* records.proposals.put(reverted);
          yield* emit("playbook.reverted", `${p.proposalId}: ${p.playbook} wording change reverted: ${verdict.reason}`, {
            proposalId: p.proposalId,
            playbook: p.playbook,
            ref: playbooks.current(p.playbook).ref,
            reason: verdict.reason,
            baseline: p.baseline,
            measured,
          });
          const cited = yield* incidents.get(p.fixesIncidents[0]!);
          if (cited !== undefined) {
            yield* incidents.record({
              class: "playbook_reverted",
              projectRef: cited.projectRef,
              evidence: [`${p.proposalId} changed ${p.playbook} (${p.fields.join(", ")}) to fix ${p.fixesIncidents.join(", ")}; reverted: ${verdict.reason}`],
            });
          }
          out.push(reverted);
        }
        return out;
      }),
    );

  const fileGateAsks: Retro["Service"]["fileGateAsks"] = () =>
    lock.withPermit(
      Effect.gen(function* () {
        const out: Array<RetroProposal> = [];
        if (!(yield* applyEnabled())) return out;
        for (const { proposal: p } of (yield* records.proposals.list({ state: "pending", limit: 50 })).filter((s) => s.proposal.kind === "gate").toReversed()) {
          const filed = yield* Effect.result(
            asks.create(
              {
                kind: "decide",
                key: gateAskKey(p),
                class: "product",
                text: clip(
                  `Playbook gate change ${p.proposalId}: ${p.playbook} ${p.fields.join(", ")}. Fixes ${p.fixesIncidents.join(", ")}; ${p.expected} (retro_proposals shows the diff)`,
                  500,
                ),
                recommendation: "apply",
                options: ["apply", "keep as is"],
                blocks: "nothing",
                proceededOnRec: false,
              },
              "retro",
            ),
          );
          if (filed._tag === "Failure") {
            yield* Effect.logWarning("retro: gate ask not filed", { proposalId: p.proposalId, error: filed.failure.message });
            continue;
          }
          // Hub-wide asks are never answered from the log, so each one reaches the person.
          const asked: RetroProposal = { ...p, state: "asked", askId: filed.success.ask.askId };
          yield* records.proposals.put(asked);
          out.push(asked);
        }
        return out;
      }),
    );

  /** A decision answering one of the retro's gate asks. */
  const onDecision = (event: HubEvent) =>
    Effect.gen(function* () {
      const data = event.data as { readonly decisionId?: DecisionId; readonly key?: string; readonly askId?: string } | undefined;
      if (data?.askId === undefined || data.decisionId === undefined || data.key?.startsWith(PLAYBOOK_ASK_PREFIX) !== true) return;
      const stored = yield* records.proposals.byAsk(data.askId as AskId);
      if (stored === undefined) return;
      const decision = yield* decisions.get(data.decisionId);
      yield* lock.withPermit(onGateAnswer(stored, decision, false));
    });

  /** Three incidents of one class within a week start a run, once per class per week. */
  const onIncident = (event: HubEvent) =>
    thresholdLock.withPermit(Effect.gen(function* () {
      const cls = (event.data as { readonly class?: IncidentClass } | undefined)?.class;
      if (cls === undefined || cls === "playbook_reverted") return;
      const now = yield* Clock.currentTimeMillis;
      const since = now - THRESHOLD_DAYS * DAY_MS;
      const count = (yield* incidents.counts({ class: cls, sinceMs: since }))[0]?.count ?? 0;
      if (count < THRESHOLD || (yield* records.runs.thresholdSince(cls, since))) return;
      yield* run({ windowDays: DEFAULT_WINDOW_DAYS, trigger: "threshold", thresholdClass: cls }).pipe(
        Effect.catchTag("RetroRefused", (refused) => Effect.logWarning("retro: threshold run refused", { class: cls, reason: refused.message })),
      );
    }));

  const weekly = Effect.gen(function* () {
    yield* run({ windowDays: DEFAULT_WINDOW_DAYS, trigger: "weekly" }).pipe(
      Effect.catchTag("RetroRefused", (refused) => Effect.logWarning("retro: weekly run refused", { reason: refused.message })),
    );
    yield* fileGateAsks();
  });

  /**
   * Monday 09:00 in policy.tz, and the end of each measuring window. Sleeps at most an hour at a time, so a changed
   * zone takes effect within the hour; after a long pause it runs once, not once per missed Monday.
   */
  const schedule = Effect.gen(function* () {
    let after = yield* Clock.currentTimeMillis;
    for (;;) {
      const tz = yield* zone;
      const monday = nextCron(WEEKLY, after, tz) ?? after + 7 * DAY_MS;
      const due = (yield* records.proposals.nextDueMs()) ?? Number.POSITIVE_INFINITY;
      const now = yield* Clock.currentTimeMillis;
      if (now < Math.min(monday, due)) {
        yield* Effect.sleep(Duration.millis(Math.min(Math.min(monday, due) - now, 3_600_000)));
        continue;
      }
      if (now >= due) yield* evaluateDue();
      if (now >= monday) {
        yield* weekly;
        after = Math.max(monday, now);
      }
    }
  });

  const service = Retro.of({
    run,
    proposals: (filter) => records.proposals.list(filter),
    lastRun: () => records.runs.latest(),
    applyEnabled,
    evaluateDue,
    fileGateAsks,
  });
  return { service, schedule, onDecision, onIncident };
});

/**
 * The retro with its weekly and end-of-window scheduler, its threshold trigger and the gate asks' answers.
 * Needs RetroRecords, RetroRunner, Incidents, Playbooks, Decisions, Asks, LeadRecords, TaskRecords and EventLog.
 */
export const layer = Layer.effect(
  Retro,
  Effect.gen(function* () {
    const { service, schedule, onDecision, onIncident } = yield* make;
    const events = yield* EventLog.EventLog;
    const scope = yield* Effect.scope;
    let cursor = yield* events.head();
    const guarded = (what: string, effect: Effect.Effect<void>) =>
      effect.pipe(Effect.catchCause((cause) => Effect.logWarning(`retro: ${what} failed`, { cause: Cause.pretty(cause) })));
    yield* Effect.forkScoped(Effect.forever(guarded("scheduler", Effect.asVoid(schedule))));
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const page = yield* events.wait({ cursor, types: ["decision.recorded", "incident.recorded"], timeoutSec: 3600 });
          cursor = page.cursor;
          for (const event of page.events) {
            if (event.type === "decision.recorded") yield* guarded("gate answer", onDecision(event));
            // A run takes a claude turn; it must not hold up the answers behind it.
            else yield* Effect.forkIn(guarded("threshold run", onIncident(event)), scope);
          }
        }),
      ),
    );
    return service;
  }),
);
