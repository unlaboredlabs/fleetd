import {
  AskId,
  BatchId,
  DecisionId,
  DecisionKey,
  MachineId,
  ProjectId,
  WorkstreamId,
  type HubEvent,
  type ProjectRef,
} from "@fleetd/contracts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import { Asks, type AskInput, DECIDE_YOURSELF, QUIET_WINDOW_MS } from "./Asks.ts";
import { Decisions } from "./Decisions.ts";
import { type Answer, AnswerSink, Inbox } from "./Inbox.ts";
import * as Ledger from "./Ledger.ts";
import { LedgerRepo } from "./LedgerRepo.ts";
import * as LedgerRepoModule from "./LedgerRepo.ts";

const P1: ProjectRef = { machineId: MachineId.make("lab-a"), projectId: ProjectId.make("p1") };
const P2: ProjectRef = { machineId: MachineId.make("lab-a"), projectId: ProjectId.make("p2") };
const W1 = WorkstreamId.make("W1");
const key = (k: string) => DecisionKey.make(k);
const human = { source: "human", by: "human:phone" } as const;
const lead = { source: "lead", by: "lead:lab-a/p1" } as const;

const run = <A, E>(
  body: (delivered: Ref.Ref<ReadonlyArray<{ project: string; answers: ReadonlyArray<Answer> }>>) => Effect.Effect<
    A,
    E,
    Asks | Decisions | Inbox | EventLog.EventLog | LedgerRepo
  >,
  db: Layer.Layer<HubDb.HubDb> = HubDb.layerMemory,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const delivered = yield* Ref.make<ReadonlyArray<{ project: string; answers: ReadonlyArray<Answer> }>>([]);
      const sink = Layer.succeed(
        AnswerSink,
        AnswerSink.of({
          onAnswered: (projectRef, answers) =>
            Ref.update(delivered, (all) => [...all, { project: projectRef.projectId, answers }]),
        }),
      );
      const layer = Layer.mergeAll(Ledger.layer, LedgerRepoModule.layer).pipe(
        Layer.provideMerge(EventLog.layer),
        Layer.provideMerge(sink),
        Layer.provideMerge(db),
        Layer.provideMerge(TestClock.layer()),
      );
      return yield* body(delivered).pipe(Effect.provide(layer));
    }),
  );

const ask = (k: string, extra: Partial<AskInput> = {}): AskInput => ({
  projectRef: P1,
  kind: "decide",
  key: key(k),
  class: "product",
  text: `What about ${k}?`,
  recommendation: `rec for ${k}`,
  blocks: "nothing",
  proceededOnRec: true,
  ...extra,
});

const eventsOf = (type?: HubEvent["type"]) =>
  Effect.gen(function* () {
    const page = yield* (yield* EventLog.EventLog).wait({ cursor: 0, timeoutSec: 0 });
    return page.events.filter((e) => type === undefined || e.type === type);
  });

const file = (input: AskInput, by: string = lead.by) =>
  Effect.gen(function* () {
    return yield* (yield* Asks).create(input, by);
  });
const reply = (raw: string, batchId?: BatchId) =>
  Effect.gen(function* () {
    return yield* (yield* Inbox).reply(batchId === undefined ? { raw } : { raw, batchId }, human);
  });
const getAsk = (id: string) =>
  Effect.gen(function* () {
    return yield* (yield* Asks).get(AskId.make(id));
  });
const batches = () =>
  Effect.gen(function* () {
    return yield* (yield* Asks).batches();
  });

describe("Decisions", () => {
  it("supersedes the active decision on the same key and scope, and only that one", () =>
    run(() =>
      Effect.gen(function* () {
        const decisions = yield* Decisions;
        const project = { kind: "project", projectRef: P1 } as const;
        const d1 = yield* decisions.record({ key: key("db.engine"), scope: project, value: "sqlite" }, human);
        const g = yield* decisions.record({ key: key("db.engine"), scope: { kind: "global" }, value: "postgres" }, human);
        const d2 = yield* decisions.record({ key: key("db.engine"), scope: project, value: "duckdb", why: "analytics" }, lead);
        expect(d2).toMatchObject({ decisionId: "D3", supersedes: "D1", source: "lead", by: lead.by, state: "active" });
        expect((yield* decisions.get(d1.decisionId))?.state).toBe("superseded");
        expect((yield* decisions.get(g.decisionId))?.state).toBe("active");
        expect((yield* eventsOf("decision.recorded")).map((e) => e.summary)).toEqual([
          "D1 db.engine = sqlite",
          "D2 db.engine = postgres",
          "D3 db.engine = duckdb",
        ]);
      }),
    ));

  it("resolves workstream before project before global, skipping other projects and retired decisions", () =>
    run(() =>
      Effect.gen(function* () {
        const decisions = yield* Decisions;
        const k = key("api.health.path");
        const chain = { projectRef: P1, workstreamId: W1 };
        expect(yield* decisions.resolve(k, chain)).toBeUndefined();
        yield* decisions.record({ key: k, scope: { kind: "global" }, value: "/health" }, human);
        expect((yield* decisions.resolve(k, chain))?.value).toBe("/health");
        yield* decisions.record({ key: k, scope: { kind: "project", projectRef: P2 }, value: "/p2" }, human);
        expect((yield* decisions.resolve(k, chain))?.value).toBe("/health");
        const proj = yield* decisions.record({ key: k, scope: { kind: "project", projectRef: P1 }, value: "/healthz" }, human);
        expect((yield* decisions.resolve(k, chain))?.value).toBe("/healthz");
        const ws = yield* decisions.record(
          { key: k, scope: { kind: "workstream", workstreamId: W1 }, value: "/ws", projectRef: P1 },
          lead,
        );
        expect((yield* decisions.resolve(k, chain))?.value).toBe("/ws");
        expect((yield* decisions.resolve(k, { projectRef: P1 }))?.value).toBe("/healthz");
        yield* decisions.retire(ws.decisionId);
        expect((yield* decisions.resolve(k, chain))?.decisionId).toBe(proj.decisionId);
        const again = yield* Effect.flip(decisions.retire(ws.decisionId));
        expect(again.message).toMatch(/already retired/u);
        expect((yield* Effect.flip(decisions.retire(DecisionId.make("D99")))).code).toBe("not_found");
      }),
    ));

  it("searches key, value and why with FTS5, within the project chain, active only", () =>
    run(() =>
      Effect.gen(function* () {
        const decisions = yield* Decisions;
        const project = (projectRef: ProjectRef) => ({ kind: "project", projectRef }) as const;
        yield* decisions.record({ key: key("api.health.path"), scope: project(P1), value: "/healthz" }, human);
        yield* decisions.record({ key: key("pkg.manager"), scope: { kind: "global" }, value: "pnpm", why: "workspace health" }, human);
        yield* decisions.record({ key: key("api.health.port"), scope: project(P2), value: "8080" }, human);
        const old = yield* decisions.record({ key: key("ui.theme"), scope: project(P1), value: "dark" }, human);
        yield* decisions.retire(old.decisionId);

        const ids = (ds: ReadonlyArray<{ decisionId: string }>) => ds.map((d) => d.decisionId);
        expect(ids(yield* decisions.search("health"))).toEqual(expect.arrayContaining(["D1", "D2", "D3"]));
        expect(ids(yield* decisions.search("health", { chain: { projectRef: P1 } })).sort()).toEqual(["D1", "D2"]);
        expect(ids(yield* decisions.search("healthz"))).toEqual(["D1"]);
        expect(ids(yield* decisions.search("health", { scope: project(P2) }))).toEqual(["D3"]);
        expect(yield* decisions.search("dark theme")).toEqual([]);
        expect(yield* decisions.search("?!")).toEqual([]);
        expect(ids(yield* decisions.list({ chain: { projectRef: P1 } }))).toEqual(["D2", "D1"]);
        expect(ids(yield* decisions.list({ source: "human", limit: 1 }))).toEqual(["D3"]);
      }),
    ));
});

describe("the ask path", () => {
  it("refuses other classes with the fix text and checks kind rules", () =>
    run(() =>
      Effect.gen(function* () {
        const naming = yield* Effect.flip(file(ask("ui.button.label", { class: "naming" })));
        expect(naming.code).toBe("invalid");
        expect(naming.message).toContain(DECIDE_YOURSELF);
        expect(naming.message).toContain("decide this yourself and log it with `fleetd decide`");
        const { recommendation: _r, ...noRec } = ask("x.y");
        expect((yield* Effect.flip(file(noRec))).message).toMatch(/needs a recommendation/u);
        expect((yield* Effect.flip(file(ask("x.y", { kind: "do" })))).message).toMatch(/at least one step/u);
        const placeholder = ask("dns.record", {
          kind: "do",
          class: "irreversible",
          steps: [
            { text: "Log in", where: "browser" },
            { text: "Add it", where: "browser", command: "dig <domain>" },
          ],
        });
        expect((yield* Effect.flip(file(placeholder))).message).toMatch(/Step 2's command has a <placeholder>/u);
        expect(yield* batches()).toEqual([]);
        expect(yield* eventsOf()).toEqual([]);
      }),
    ));

  it("answers a decided key from the log, never batching it", () =>
    run(() =>
      Effect.gen(function* () {
        const decisions = yield* Decisions;
        yield* decisions.record({ key: key("api.health.path"), scope: { kind: "global" }, value: "/health" }, human);
        yield* decisions.record(
          { key: key("api.health.path"), scope: { kind: "project", projectRef: P1 }, value: "/healthz" },
          human,
        );
        const outcome = yield* file(ask("api.health.path", { workstreamId: W1 }));
        expect(outcome.state).toBe("auto");
        expect(outcome.decision?.decisionId).toBe("D2");
        expect(outcome.ask).toMatchObject({ askId: "A1", state: "auto", decisionId: "D2" });
        expect(outcome.ask.batchId).toBeUndefined();
        expect((yield* eventsOf("ask.auto")).map((e) => e.data)).toEqual([
          { askId: "A1", key: "api.health.path", decisionId: "D2" },
        ]);
        expect(yield* batches()).toEqual([]);
        // Another project falls back to the global decision; a key nobody decided is asked.
        expect((yield* file(ask("api.health.path", { projectRef: P2 }))).decision?.decisionId).toBe("D1");
        expect((yield* file(ask("api.health.method", { projectRef: P2 }))).state).toBe("open");
      }),
    ));

  it("attaches a repeat key to the open ask in the same project, not across projects", () =>
    run(() =>
      Effect.gen(function* () {
        const first = yield* file(ask("api.health.path"));
        const again = yield* file(ask("api.health.path", { text: "Which path again?" }));
        expect(again).toMatchObject({ state: "open", attached: true });
        expect(again.ask.askId).toBe(first.ask.askId);
        const other = yield* file(ask("api.health.path", { projectRef: P2 }));
        expect(other.ask.askId).toBe("A2");
        expect((yield* batches())[0]?.items).toEqual([
          { number: 1, askId: "A1" },
          { number: 2, askId: "A2" },
        ]);
        expect(yield* eventsOf("ask.created")).toHaveLength(2);
      }),
    ));

  it("returns up to 5 lexical candidates in scope, and withdraws with --use", () =>
    run(() =>
      Effect.gen(function* () {
        const decisions = yield* Decisions;
        for (let i = 0; i < 7; i++) {
          yield* decisions.record(
            { key: key(`api.health.v${i}`), scope: { kind: "project", projectRef: P1 }, value: `/health${i}` },
            human,
          );
        }
        yield* decisions.record({ key: key("api.health.other"), scope: { kind: "project", projectRef: P2 }, value: "x" }, human);
        const outcome = yield* file(ask("api.health.path"));
        expect(outcome.candidates).toHaveLength(5);
        expect(outcome.candidates?.every((d) => d.scope.kind === "project" && d.scope.projectRef.projectId === "p1")).toBe(true);

        const asks = yield* Asks;
        const wrongProject = yield* Effect.flip(asks.withdraw(outcome.ask.askId, { projectRef: P2 }));
        expect(wrongProject.code).toBe("not_found");
        const withdrawn = yield* asks.withdraw(outcome.ask.askId, { use: DecisionId.make("D3"), projectRef: P1 });
        expect(withdrawn).toMatchObject({ state: "withdrawn", decisionId: "D3" });
        expect((yield* batches())[0]?.state).toBe("closed");
        expect((yield* Effect.flip(asks.withdraw(outcome.ask.askId))).message).toMatch(/already withdrawn/u);
      }),
    ));

  it("publishes a batch after 30 s with no new ask, restarting the window on each ask", () =>
    run(() =>
      Effect.gen(function* () {
        yield* file(ask("a.one"));
        yield* TestClock.adjust(QUIET_WINDOW_MS - 1000);
        yield* file(ask("a.two"));
        yield* TestClock.adjust(QUIET_WINDOW_MS - 1000);
        expect(yield* eventsOf("batch.ready")).toEqual([]);
        yield* TestClock.adjust(1000);
        const ready = yield* eventsOf("batch.ready");
        expect(ready.map((e) => e.data)).toEqual([
          {
            batchId: "B1",
            items: [
              { number: 1, askId: "A1" },
              { number: 2, askId: "A2" },
            ],
          },
        ]);
        // After publication new asks start B2, numbered from 1; B1's numbers never change.
        const third = yield* file(ask("a.three"));
        expect(third.ask).toMatchObject({ batchId: "B2", number: 1 });
        yield* TestClock.adjust(QUIET_WINDOW_MS);
        expect((yield* eventsOf("batch.ready")).map((e) => (e.data as { batchId: string }).batchId)).toEqual(["B1", "B2"]);
        expect((yield* getAsk("A2"))?.number).toBe(2);
      }),
    ));

  it("publishes at once for a blocking money, credential or irreversible ask", () =>
    run(() =>
      Effect.gen(function* () {
        yield* file(ask("ui.copy"));
        yield* file(ask("sentry.plan", { class: "money", blocks: "nothing" }));
        expect(yield* eventsOf("batch.ready")).toEqual([]);
        yield* file(ask("prod.migrate", { class: "irreversible", blocks: "run the migration" }));
        const ready = yield* eventsOf("batch.ready");
        expect(ready.map((e) => (e.data as { items: ReadonlyArray<unknown> }).items.length)).toEqual([3]);
        // The cancelled quiet timer does not publish again.
        yield* TestClock.adjust(QUIET_WINDOW_MS * 2);
        expect(yield* eventsOf("batch.ready")).toHaveLength(1);
      }),
    ));

  it("a batch still collecting when the hub stops publishes after the hub comes back", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-ledger-"));
    try {
      const db = HubDb.layer(home);
      await run(() => file(ask("a.one")), db);
      await run(
        () =>
          Effect.gen(function* () {
            expect(yield* eventsOf("batch.ready")).toEqual([]);
            yield* TestClock.adjust(QUIET_WINDOW_MS);
            expect((yield* eventsOf("batch.ready")).map((e) => e.summary)).toEqual(["B1 ready: 1 question"]);
          }),
        db,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("a product ask that blocks a step still waits for the quiet window", () =>
    run(() =>
      Effect.gen(function* () {
        yield* file(ask("ui.copy", { blocks: "ship the page" }));
        expect(yield* eventsOf("batch.ready")).toEqual([]);
        yield* TestClock.adjust(QUIET_WINDOW_MS);
        expect(yield* eventsOf("batch.ready")).toHaveLength(1);
      }),
    ));
});

describe("Inbox.reply", () => {
  it("1 go writes the decision, echoes it, delivers it, and the next ask is auto", () =>
    run((delivered) =>
      Effect.gen(function* () {
        yield* file(ask("api.health.path", { text: "Path?", recommendation: "/healthz" }));
        const out = yield* reply("1 go");
        expect(out).toMatchObject({ parsed: true, batchId: "B1", echo: "Logged: 1 → /healthz (D1)" });
        expect(out.applied).toEqual([
          { number: 1, askId: "A1", outcome: "answered", value: "/healthz", decisionId: "D1", source: "human", by: "human:phone" },
        ]);
        const decision = yield* (yield* Decisions).get(DecisionId.make("D1"));
        expect(decision).toMatchObject({
          key: "api.health.path",
          value: "/healthz",
          scope: { kind: "project", projectRef: P1 },
          source: "human",
          askId: "A1",
        });
        expect(yield* getAsk("A1")).toMatchObject({
          state: "answered",
          decisionId: "D1",
          answer: { value: "/healthz", by: "human:phone", raw: "1 go" },
        });
        const sent = yield* Ref.get(delivered);
        expect(sent.map((s) => [s.project, s.answers.map((a) => [a.ask.askId, a.outcome, a.value])])).toEqual([
          ["p1", [["A1", "answered", "/healthz"]]],
        ]);
        expect((yield* batches())[0]?.state).toBe("closed");
        expect(yield* eventsOf("decision.recorded")).toHaveLength(1);
        expect((yield* file(ask("api.health.path"))).state).toBe("auto");
      }),
    ));

  it("applies a mixed reply, withdraws nvm'd product asks as misfiled, and groups deliveries per project", () =>
    run((delivered) =>
      Effect.gen(function* () {
        yield* file(ask("a.one"));
        yield* file(ask("a.two"));
        yield* file(ask("a.three", { projectRef: P2, options: ["red", "blue"] }));
        yield* file(ask("a.four", { class: "money" }));
        const out = yield* reply("1 go 2 nvm 3 b 4 no");
        expect(out.echo).toBe("Logged: 1 → rec for a.one (D1), 2 → dropped, 3 → blue (D2), 4 → no (D3)");
        expect(yield* getAsk("A2")).toMatchObject({ state: "withdrawn", answer: { value: "dropped" } });
        const repo = yield* LedgerRepo;
        expect(repo.incidents()).toEqual([{ askId: "A2", kind: "misfiled" }]);
        const sent = yield* Ref.get(delivered);
        expect(sent.map((s) => [s.project, s.answers.map((a) => a.ask.askId)])).toEqual([
          ["p1", ["A1", "A2", "A4"]],
          ["p2", ["A3"]],
        ]);
      }),
    ));

  it("an unrouted intake.route.* ask has no project: its answer is a global decision and wakes no lead", () =>
    run((delivered) =>
      Effect.gen(function* () {
        const { projectRef: _, ...unrouted } = ask("docs.where");
        expect((yield* Effect.flip(file(unrouted))).message).toMatch(/Only an intake\.route\.\* ask may leave out its project/u);
        yield* file({ ...unrouted, key: key("intake.route.tidy-docs-abc123"), options: ["repo-a on lab-a", "repo-b on lab-a"] }, "k1");
        yield* file(ask("a.one"));
        expect((yield* getAsk("A1"))?.projectRef).toBeUndefined();
        expect((yield* eventsOf("ask.created"))[0]?.machineId).toBeUndefined();
        expect((yield* reply("1 b 2 go")).echo).toBe("Logged: 1 → repo-b on lab-a (D1), 2 → rec for a.one (D2)");
        const decisions = yield* Decisions;
        expect(yield* decisions.get(DecisionId.make("D1"))).toMatchObject({ key: "intake.route.tidy-docs-abc123", scope: { kind: "global" }, askId: "A1" });
        expect((yield* Ref.get(delivered)).map((s) => [s.project, s.answers.map((a) => a.ask.askId)])).toEqual([["p1", ["A2"]]]);
      }),
    ));

  it("recs fine accepts what is left; items not mentioned stay open", () =>
    run(() =>
      Effect.gen(function* () {
        yield* file(ask("a.one"));
        yield* file(ask("a.two"));
        yield* file(ask("a.three"));
        expect((yield* reply("2 go")).echo).toBe("Logged: 2 → rec for a.two (D1)");
        expect((yield* getAsk("A1"))?.state).toBe("open");
        expect((yield* batches())[0]?.state).toBe("open");
        expect((yield* reply("3 nvm recs fine")).echo).toBe("Logged: 1 → rec for a.one (D2), 3 → dropped");
        expect((yield* batches())[0]?.state).toBe("closed");
        expect(yield* reply("1 go")).toMatchObject({ parsed: false, hint: "There is no open batch to answer." });
      }),
    ));

  it("malformed or mismatched replies change nothing", () =>
    run((delivered) =>
      Effect.gen(function* () {
        yield* file(ask("a.one"));
        yield* file(ask("a.two"));
        const before = yield* eventsOf();
        for (const raw of ["1 go 2 maybe", "1 go 3 go", "1 go 2 c", "1 go forget D7", "1 go #B1", "#B9 1 go"]) {
          const out = yield* reply(raw);
          expect(out.parsed, raw).toBe(false);
          expect(out.applied).toEqual([]);
          expect(out.hint).toBeTruthy();
        }
        expect(yield* reply("1 go", BatchId.make("B2"))).toMatchObject({ parsed: false });
        expect((yield* getAsk("A1"))?.state).toBe("open");
        expect(yield* (yield* Decisions).list({})).toEqual([]);
        expect(yield* eventsOf()).toEqual(before);
        expect(yield* Ref.get(delivered)).toEqual([]);
      }),
    ));

  it("binds to the latest published batch unless the reply names one", () =>
    run(() =>
      Effect.gen(function* () {
        yield* file(ask("a.one"));
        yield* TestClock.adjust(QUIET_WINDOW_MS);
        yield* file(ask("a.two"));
        // B1 is published, B2 is still collecting: "1 go" means B1's item 1.
        expect((yield* reply("1 go")).echo).toBe("Logged: 1 → rec for a.one (D1)");
        const viaPrefix = yield* reply("#B2 1 go");
        expect(viaPrefix).toMatchObject({ batchId: "B2", echo: "Logged: 1 → rec for a.two (D2)" });
      }),
    ));

  it("later moves an item to the next batch without renumbering the old one", () =>
    run(() =>
      Effect.gen(function* () {
        yield* file(ask("a.one"));
        yield* file(ask("a.two"));
        yield* TestClock.adjust(QUIET_WINDOW_MS);
        expect((yield* reply("1 later 2 go")).echo).toBe("Logged: 1 → later (B2#1), 2 → rec for a.two (D1)");
        const [b2, b1] = yield* batches();
        expect(b1).toMatchObject({ batchId: "B1", state: "closed", items: [{ number: 1, askId: "A1" }, { number: 2, askId: "A2" }] });
        expect(b2).toMatchObject({ batchId: "B2", state: "open", items: [{ number: 1, askId: "A1" }] });
        // A moved item waits for the next new ask rather than coming back in 30 s.
        yield* TestClock.adjust(QUIET_WINDOW_MS * 4);
        expect(yield* eventsOf("batch.ready")).toHaveLength(1);
        yield* file(ask("a.three"));
        yield* TestClock.adjust(QUIET_WINDOW_MS);
        expect((yield* eventsOf("batch.ready")).map((e) => e.data)).toEqual([
          expect.anything(),
          { batchId: "B2", items: [{ number: 1, askId: "A1" }, { number: 2, askId: "A3" }] },
        ]);
        expect((yield* reply("1 nvm 2 nvm")).echo).toBe("Logged: 1 → dropped, 2 → dropped");
      }),
    ));

  it("pref: records a global human decision under pref.<slug>, and forget retires a decision", () =>
    run(() =>
      Effect.gen(function* () {
        const out = yield* reply("pref: Always use pnpm!");
        expect(out).toMatchObject({ parsed: true, echo: "Logged: pref.always-use-pnpm → D1" });
        expect(out.batchId).toBeUndefined();
        const decisions = yield* Decisions;
        expect(yield* decisions.get(DecisionId.make("D1"))).toMatchObject({
          key: "pref.always-use-pnpm",
          scope: { kind: "global" },
          value: "Always use pnpm!",
          source: "human",
        });
        yield* reply("pref: always use pnpm");
        expect((yield* decisions.get(DecisionId.make("D1")))?.state).toBe("superseded");
        expect((yield* reply("forget D2")).echo).toBe("Logged: D2 → forgotten");
        expect(yield* decisions.list({})).toEqual([]);
        expect((yield* reply("forget D2")).hint).toMatch(/already retired/u);
      }),
    ));

  it("do-asks take done, and recs fine leaves them open", () =>
    run(() =>
      Effect.gen(function* () {
        const { recommendation: _r, ...base } = ask("github.token");
        yield* file({ ...base, kind: "do", class: "credential", steps: [{ text: "Create a token", where: "browser" }] });
        expect((yield* reply("recs fine")).echo).toBe("Nothing to log: no open item needed an answer.");
        expect((yield* reply("1 done")).echo).toBe("Logged: 1 → done (D1)");
      }),
    ));
});
