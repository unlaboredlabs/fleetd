// The retro on synthetic incident histories, with the TestClock standing in for the weeks between a change and its
// verdict. The model is a canned answer, except in the last test, where a stand-in `claude` binary shows the run
// goes through the router's isolated runner.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DecisionKey, HubEvent, HubEventType, IncidentClass, PlaybookRef, WorkstreamId } from "@fleetd/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";
import { Incidents } from "../incidents/Incidents.ts";
import { makeFakeClaude, result } from "../intake/fakeClaude.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import { REF } from "../leads/testKit.ts";
import { Asks } from "../ledger/Asks.ts";
import { Decisions } from "../ledger/Decisions.ts";
import * as Inbox from "../ledger/Inbox.ts";
import * as Ledger from "../ledger/Ledger.ts";
import { gitBlobSha } from "../playbooks/load.ts";
import * as Playbooks from "../playbooks/Playbooks.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as TaskRecords from "../tasks/TaskRecords.ts";
import { suggestedLines } from "./digest.ts";
import * as Retro from "./Retro.ts";
import * as RetroRecords from "./RetroRecords.ts";
import { answer, bundled, change, edit, GATE, WORDING } from "./testKit.ts";

const DAY = Duration.days(1);
const dirs: Array<string> = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The services a retro needs over an in-memory hub, with the model's replies queued in `replies`. */
const setup = (replies: Array<string>, runner?: Layer.Layer<Retro.RetroRunner>) => {
  const overrides = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-retro-"));
  dirs.push(overrides);
  const prompts: Array<string> = [];
  const canned = Layer.succeed(
    Retro.RetroRunner,
    Retro.RetroRunner.of({
      ask: (prompt) =>
        Effect.sync(() => {
          prompts.push(prompt);
          const text = replies.shift();
          const run = { kind: "orchestrator" as const, model: "claude-haiku-5-5", durationMs: 1200, inputTokens: 900, outputTokens: 200 };
          return text === undefined ? { run: { ...run, ok: false, error: "no reply" } } : { text, run: { ...run, ok: true } };
        }),
    }),
  );
  const layer = Layer.mergeAll(RetroRecords.layer, runner ?? canned, Playbooks.layer({ overridesDir: overrides }), LeadRecords.layer, TaskRecords.layer).pipe(
    Layer.provideMerge(Ledger.layer),
    Layer.provideMerge(Inbox.layerAnswerSinkNoop),
    Layer.provideMerge(EventLog.layer),
    Layer.provideMerge(HubDb.layerMemory),
    Layer.provideMerge(TestClock.layer()),
  );
  const file = path.join(overrides, "bugfix.md");
  return {
    prompts,
    override: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined),
    run: <A, E>(body: Effect.Effect<A, E, Layer.Success<typeof layer> | Scope.Scope>) =>
      Effect.runPromise(Effect.scoped(Effect.provide(body, layer))),
  };
};

const human = { source: "human", by: "human:phone" } as const;
const decide = (key: string, value: string) =>
  Effect.flatMap(Decisions, (d) => d.record({ key: key as DecisionKey, scope: { kind: "global" }, value }, human));
const allowApply = decide(Retro.APPLY_KEY, "true");

const incident = (cls: IncidentClass, workstreamId?: WorkstreamId) =>
  Effect.flatMap(Incidents, (i) => i.record({ class: cls, projectRef: REF, ...(workstreamId === undefined ? {} : { workstreamId }), evidence: [`a ${cls}`] }));
const incidents = (cls: IncidentClass, n: number) => Effect.forEach(Array.from({ length: n }), () => incident(cls));

const eventsOf = (type: HubEventType) =>
  Effect.map(
    Effect.flatMap(EventLog.EventLog, (log) => log.wait({ cursor: 0, types: [type], timeoutSec: 0 })),
    (page) => page.events,
  );

/** The retro's service and its event handlers, without the scheduler fibers. */
const retro = Retro.make;

const manual = { windowDays: 14, trigger: "manual" } as const;
const BUGFIX_REF = `bugfix@${gitBlobSha(bundled("bugfix"))}`;

describe("retro", () => {
  it("is advise-only by default: proposals are suggested, nothing is written, and the turn is orchestrator usage", async () => {
    const t = setup([answer(change({ diff: WORDING })), answer(change({ diff: WORDING }))]);
    await t.run(
      Effect.gen(function* () {
        yield* TestClock.adjust(Duration.days(30));
        yield* incidents("false_claim", 2);
        const { service } = yield* retro;
        const { run, proposals } = yield* service.run(manual);
        expect(run).toMatchObject({ run: 1, advise: true, incidents: 2, dropped: [], usage: { kind: "orchestrator", ok: true, inputTokens: 900 } });
        expect(proposals).toMatchObject([{ proposalId: "R1", state: "suggested", kind: "wording", fields: ["leadInstructions"], fixesIncidents: ["I1"] }]);
        expect(t.override()).toBeUndefined();
        expect((yield* Playbooks.Playbooks).current("bugfix").ref).toBe(BUGFIX_REF);

        // The fixed prompt from the repo, with the window's incidents, every playbook and the metric list.
        expect(t.prompts[0]).toContain("You are fleetd's retro.");
        expect(t.prompts[0]).toContain('"id":"I2","class":"false_claim"');
        expect(t.prompts[0]).toContain("=== finish-all.md ===");
        expect(t.prompts[0]).toContain("class is one of: false_claim, estimate_miss, polish_loop, misfiled_ask, out_of_area, stall, policy_bypass, re_ask, override, agent_minutes_per_done.");
        expect(t.prompts[0]).not.toMatch(/\{\{\w+\}\}/u);
        const [ran] = yield* eventsOf("retro.ran");
        expect(ran!.data).toMatchObject({ run: 1, trigger: "manual", advise: true, proposals: ["R1"], usage: [{ kind: "orchestrator", model: "claude-haiku-5-5", ok: true }] });

        expect(suggestedLines(proposals)).toEqual([
          "Suggested R1: bugfix wording (leadInstructions) · fixes I1 · aims to cut false_claim incidents over 14 d",
          "Retro suggestions apply only once policy.retro.apply = true; retro_proposals has the diffs.",
        ]);

        // --advise holds even once applying is allowed.
        yield* allowApply;
        expect((yield* service.run({ ...manual, advise: true })).proposals).toMatchObject([{ state: "suggested" }]);
        expect(t.override()).toBeUndefined();
      }),
    );
  });

  it("applies a wording change as a new override that new workstreams pin, and keeps it when its metric improves", async () => {
    const t = setup([answer(change({ diff: WORDING, fixesIncidents: ["I2"] }))]);
    await t.run(
      Effect.gen(function* () {
        yield* allowApply;
        yield* TestClock.adjust(Duration.days(30));
        yield* incidents("false_claim", 3);
        yield* TestClock.adjust(Duration.hours(1));
        const { service } = yield* retro;
        const playbooks = yield* Playbooks.Playbooks;
        const [applied] = (yield* service.run(manual)).proposals;
        expect(applied).toMatchObject({
          state: "measuring",
          previousRef: BUGFIX_REF,
          dueAt: "1970-02-14T01:00:00.000Z",
          baseline: { target: 3, false_claim: 3, estimate_miss: 0, polish_loop: 0, agent_minutes_per_done: null },
        });
        expect(t.override()).toContain("Run the repro yourself before you claim done.");
        expect(applied!.ref).toBe(`bugfix@${gitBlobSha(t.override()!)}`);
        // New workstreams pin the new version; the old one still resolves for the ones that pinned it.
        expect((yield* playbooks.pin("bugfix")).ref).toBe(applied!.ref);
        expect((yield* playbooks.byRef(BUGFIX_REF as PlaybookRef))?.playbook.leadInstructions).toContain("When the repro passes, claim done.");
        const [changed] = yield* eventsOf("playbook.changed");
        expect(changed!.data).toMatchObject({ proposalId: "R1", playbook: "bugfix", kind: "wording", ref: applied!.ref, baseline: { target: 3 } });

        // Not due yet: nothing is judged.
        yield* TestClock.adjust(Duration.days(13));
        expect(yield* service.evaluateDue()).toEqual([]);
        yield* incident("false_claim");
        yield* TestClock.adjust(DAY);
        const [kept] = yield* service.evaluateDue();
        expect(kept).toMatchObject({ state: "kept", measured: { target: 1 } });
        expect(t.override()).toContain("Run the repro yourself before you claim done.");
        expect((yield* eventsOf("playbook.kept"))[0]!.data).toMatchObject({ proposalId: "R1", measured: { target: 1 } });
        expect(yield* eventsOf("playbook.reverted")).toEqual([]);
      }),
    );
  });

  it("reverts to the file it replaced when the metric does not improve, and records an incident", async () => {
    const t = setup([answer(change({ diff: WORDING }))]);
    await t.run(
      Effect.gen(function* () {
        yield* allowApply;
        const playbooks = yield* Playbooks.Playbooks;
        // The user's own override was in use before the retro's.
        const mine = bundled("bugfix").replace("not something an agent says.", "not something an agent claims.");
        yield* playbooks.setOverride("bugfix", mine);
        yield* TestClock.adjust(Duration.days(30));
        yield* incidents("false_claim", 2);
        yield* TestClock.adjust(Duration.hours(1));
        const { service } = yield* retro;
        const [applied] = (yield* service.run(manual)).proposals;
        expect(applied).toMatchObject({ state: "measuring", baseline: { target: 2 } });
        expect(t.override()).toContain("not something an agent claims.");
        expect(t.override()).toContain("Run the repro yourself");

        yield* incidents("false_claim", 2);
        yield* TestClock.adjust(Duration.days(14));
        const [reverted] = yield* service.evaluateDue();
        expect(reverted).toMatchObject({ state: "reverted", measured: { target: 2 }, note: "the metric did not improve (2 before, 2 after)" });
        expect(t.override()).toBe(mine);
        expect(playbooks.current("bugfix").ref).toBe(`bugfix@${gitBlobSha(mine)}`);
        expect((yield* eventsOf("playbook.reverted"))[0]!.data).toMatchObject({ proposalId: "R1", reason: "the metric did not improve (2 before, 2 after)" });
        const [recorded] = yield* (yield* Incidents).list({ class: "playbook_reverted", limit: 5 });
        expect(recorded).toMatchObject({ projectRef: REF });
        expect(recorded!.evidence[0]).toMatch(/^R1 changed bugfix \(leadInstructions\) to fix I1; reverted: the metric did not improve/u);
      }),
    );
  });

  it("reverts when a guarded metric regresses, counting only this playbook's workstreams and unowned incidents", async () => {
    const stalled = change({ diff: WORDING, fixesIncidents: ["I1", "I2"], metric: { class: "stall", op: "decrease", windowDays: 7 } });
    const t = setup([answer(stalled)]);
    await t.run(
      Effect.gen(function* () {
        yield* allowApply;
        yield* TestClock.adjust(Duration.days(30));
        yield* incidents("stall", 2);
        yield* TestClock.adjust(Duration.hours(1));
        const { service } = yield* retro;
        const [applied] = (yield* service.run(manual)).proposals;
        expect(applied).toMatchObject({ state: "measuring", baseline: { target: 2, estimate_miss: 0 } });

        // A miss on a feature workstream is not bugfix's; one on no workstream counts for every playbook.
        const feature = (yield* (yield* LeadRecords.LeadRecords).workstreams.create({
          ref: REF,
          title: "a feature",
          source: { text: "a feature", channel: "mcp", by: "k1", at: "1970-01-31T01:00:00.000Z" },
          playbook: `feature@${gitBlobSha(bundled("feature"))}` as PlaybookRef,
        })).workstream;
        yield* incident("estimate_miss", feature.workstreamId);
        yield* incident("estimate_miss");
        yield* TestClock.adjust(Duration.days(7));
        const [reverted] = yield* service.evaluateDue();
        expect(reverted).toMatchObject({ state: "reverted", measured: { target: 0, estimate_miss: 1 }, note: "estimate_miss regressed (0 before, 1 after)" });
        expect(t.override()).toBeUndefined();
        expect((yield* Playbooks.Playbooks).current("bugfix").ref).toBe(BUGFIX_REF);
      }),
    );
  });

  it("turns gate changes into one batch of hub-wide asks: go applies, no rejects", async () => {
    const featureGate = change({ playbook: "feature", kind: "gate", diff: edit("feature", "maxReviewRounds: 3", "maxReviewRounds: 2") });
    const t = setup([answer(change({ diff: GATE, kind: "wording" }), featureGate), answer()]);
    await t.run(
      Effect.gen(function* () {
        yield* allowApply;
        yield* TestClock.adjust(Duration.days(30));
        yield* incidents("polish_loop", 2);
        const r = yield* retro;
        const { proposals } = yield* r.service.run(manual);
        expect(proposals).toMatchObject([
          { proposalId: "R1", playbook: "bugfix", kind: "gate", claimedKind: "wording", state: "pending", fields: ["reviewRules"] },
          { proposalId: "R2", playbook: "feature", kind: "gate", state: "pending", fields: ["valueBar"] },
        ]);
        expect(proposals[0]!.note).toBe("the model called it wording; it changes reviewRules, so it is a gate change");
        expect(t.override()).toBeUndefined();

        const asked = yield* r.service.fileGateAsks();
        expect(asked.map((p) => [p.proposalId, p.state, p.askId])).toEqual([
          ["R1", "asked", "A1"],
          ["R2", "asked", "A2"],
        ]);
        const asks = yield* Asks;
        const [a1, a2] = yield* asks.list({ state: "open" });
        expect(a1).toMatchObject({ kind: "decide", class: "product", recommendation: "apply", batchId: "B1", number: 1 });
        expect(a1!.projectRef).toBeUndefined();
        expect(a1!.key).toMatch(/^playbook\.bugfix\.[0-9a-f]{10}$/u);
        expect(a1!.text).toContain("Playbook gate change R1: bugfix reviewRules. Fixes I1;");
        expect(a2).toMatchObject({ batchId: "B1", number: 2 });

        const cursor = yield* (yield* EventLog.EventLog).head();
        yield* (yield* Inbox.Inbox).reply({ raw: "1 go 2 no" }, human);
        const decided = (yield* (yield* EventLog.EventLog).wait({ cursor, types: ["decision.recorded"], timeoutSec: 0 })).events;
        for (const event of decided) yield* r.onDecision(event);
        const [r1] = yield* r.service.proposals({ state: "applied", limit: 5 });
        expect(r1!.proposal).toMatchObject({ proposalId: "R1", previousRef: BUGFIX_REF });
        expect(t.override()).toContain("M: { reviewers: 1, verifier: true, planFirst: false }");
        expect((yield* eventsOf("playbook.changed"))[0]!.data).toMatchObject({ proposalId: "R1", kind: "gate" });

        // "no" withdrew the second ask; the next run settles it as rejected.
        yield* r.service.run(manual);
        const [r2] = yield* r.service.proposals({ state: "rejected", limit: 5 });
        expect(r2!.proposal).toMatchObject({ proposalId: "R2", note: "the ask was withdrawn" });
      }),
    );
  });

  it("files no gate ask while advise-only, and holds a playbook whose change is pending", async () => {
    const t = setup([answer(change({ diff: GATE }))]);
    await t.run(
      Effect.gen(function* () {
        yield* allowApply;
        yield* TestClock.adjust(Duration.days(30));
        yield* incidents("polish_loop", 1);
        const r = yield* retro;
        yield* r.service.run(manual);
        yield* decide(Retro.APPLY_KEY, "false");
        expect(yield* r.service.fileGateAsks()).toEqual([]);
        expect(yield* (yield* Asks).list({})).toEqual([]);
      }),
    );
  });

  it("spends at most 2 turns a day; a run with no incidents spends none", async () => {
    const t = setup([answer(), answer(), answer()]);
    await t.run(
      Effect.gen(function* () {
        yield* TestClock.adjust(Duration.days(30));
        const { service } = yield* retro;
        expect((yield* service.run(manual)).run.usage).toBeUndefined();
        expect(t.prompts).toHaveLength(0);
        yield* incident("stall");
        yield* service.run(manual);
        yield* TestClock.adjust(Duration.hours(2));
        yield* service.run(manual);
        const refused = yield* Effect.flip(service.run(manual));
        expect(refused).toMatchObject({
          _tag: "RetroRefused",
          message: "2 retro runs already spent a claude turn in the last 24 h; the budget is 2 a day.",
          fix: "Run it again from 1970-02-01T00:00:00.000Z.",
        });
        expect(t.prompts).toHaveLength(2);
        yield* TestClock.adjust(Duration.hours(22));
        expect((yield* service.run(manual)).run.run).toBe(4);
        expect(t.prompts).toHaveLength(3);
      }),
    );
  });

  it("starts a run when a class reaches 3 incidents in 7 days, once per class per week", async () => {
    const t = setup([answer(), answer()]);
    await t.run(
      Effect.gen(function* () {
        yield* TestClock.adjust(Duration.days(30));
        const r = yield* retro;
        const records = yield* RetroRecords.RetroRecords;
        const landed = (i: { readonly incidentId: string; readonly class: IncidentClass }) =>
          r.onIncident({ seq: 1, at: "", type: "incident.recorded", summary: "", data: { incidentId: i.incidentId, class: i.class } } as HubEvent);
        yield* landed(yield* incident("stall"));
        yield* landed(yield* incident("stall"));
        yield* landed(yield* incident("override"));
        expect(yield* records.runs.latest()).toBeUndefined();
        yield* landed(yield* incident("stall"));
        expect(yield* records.runs.latest()).toMatchObject({ run: 1, trigger: "threshold", incidents: 4 });
        yield* landed(yield* incident("stall"));
        expect((yield* records.runs.latest())?.run).toBe(1);
        yield* TestClock.adjust(Duration.days(8));
        yield* incidents("stall", 2);
        yield* landed(yield* incident("stall"));
        expect(yield* records.runs.latest()).toMatchObject({ run: 2, trigger: "threshold" });
      }),
    );
  });

  it("runs weekly on Monday 09:00 in policy.tz and measures changes when their window ends", async () => {
    const t = setup([]);
    await t.run(
      Effect.gen(function* () {
        // The TestClock starts on Thursday 1970-01-01; New York is on EST (UTC-5).
        yield* decide("policy.tz", "America/New_York");
        yield* Layer.build(Retro.layer);
        yield* TestClock.adjust(Duration.hours(4 * 24 + 14 - 1));
        expect(yield* eventsOf("retro.ran")).toEqual([]);
        yield* TestClock.adjust(Duration.hours(1));
        const [ran] = yield* eventsOf("retro.ran");
        expect(ran).toMatchObject({ at: "1970-01-05T14:00:00.000Z", data: { trigger: "weekly", proposals: [] } });
        expect(t.prompts).toHaveLength(0);
      }),
    );
  });

  it("runs its turn through the router's isolated claude runner", async () => {
    const fake = makeFakeClaude([result(answer(change({ diff: WORDING })))]);
    cleanups.push(fake.cleanup);
    const t = setup([], Retro.layerRunner({ home: fake.home, env: fake.env }));
    await t.run(
      Effect.gen(function* () {
        yield* incident("false_claim");
        const { run, proposals } = yield* (yield* retro).service.run(manual);
        expect(run.usage).toMatchObject({ kind: "orchestrator", model: "claude-haiku-5-5", ok: true, inputTokens: 120, outputTokens: 30 });
        expect(proposals).toMatchObject([{ state: "suggested" }]);
      }),
    );
    const [call] = fake.calls();
    expect(call!.args).toEqual(["-p", "--output-format", "json", "--model", "claude-haiku-5-5", "--tools", "", "--strict-mcp-config", "--no-session-persistence"]);
    expect(call!.env.CLAUDE_CONFIG_DIR).toMatch(/\/hub\/claude-router$/u);
    expect(Object.keys(call!.env).filter((k) => k.startsWith("CLAUDE"))).toEqual(["CLAUDE_CONFIG_DIR"]);
    expect(call!.prompt).toContain('"id":"I1","class":"false_claim"');
  });
});
