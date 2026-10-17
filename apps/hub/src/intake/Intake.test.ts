import type { HubEvent, MachineId, ProjectId, ProjectRef } from "@fleetd/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";
import * as Workstreams from "../leads/Workstreams.ts";
import { makeKit, OTHER, REF, reply } from "../leads/testKit.ts";
import { Asks } from "../ledger/Asks.ts";
import * as EventLog from "../store/EventLog.ts";
import { makeFakeClaude, result, type Reply } from "./fakeClaude.ts";
import * as Intake from "./Intake.ts";
import * as Router from "./Router.ts";

const THIRD: ProjectRef = { machineId: "lab-b" as MachineId, projectId: "p3" as ProjectId };

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

/** The leads kit with repo-a and repo-b on lab-a and repo-c on lab-b, plus intake over a fake `claude`. */
const setup = (replies: ReadonlyArray<Reply>) => {
  const fake = makeFakeClaude(replies);
  cleanups.push(fake.cleanup);
  const kit = makeKit();
  const layer = Intake.layer.pipe(Layer.provide(Router.layer({ home: fake.home, env: fake.env })), Layer.provideMerge(kit.layer));
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.provide(
          Effect.gen(function* () {
            yield* kit.addProject(REF, "repo-a");
            yield* kit.addProject(OTHER, "repo-b");
            yield* kit.addProject(THIRD, "repo-c");
            return yield* effect;
          }),
          layer,
        ),
      ),
    );
  return { fake, run };
};

const submit = (text: string, over: Partial<Intake.SubmitInput> = {}) =>
  Effect.flatMap(Intake.Intake, (intake) =>
    intake.submit({ text, clientRequestId: text, channel: "mcp", by: "k1", allows: (machineId) => machineId === "lab-a", ...over }),
  );

const routedEvents = (cursor = 0) =>
  Effect.map(
    Effect.flatMap(EventLog.EventLog, (log) => log.wait({ cursor, types: ["intake.routed"], timeoutSec: 0 })),
    (page) => page.events,
  );

const dataOf = (event: HubEvent | undefined) => event?.data as Record<string, unknown> | undefined;

describe("Intake", () => {
  it("routes an intent without a project through the router; a prefix sets the template and a retry reuses the answer", async () => {
    const { fake, run } = setup([result({ projectRef: REF, template: "feature", reason: "repo-a holds the lab README" })]);
    await run(
      Effect.gen(function* () {
        const first = yield* submit("fix: the lab README has a typo");
        expect(first).toMatchObject({
          workstreamId: "W1",
          echo: { projectRef: REF, template: "bugfix", reason: "repo-a holds the lab README (template bugfix from the fix: prefix)" },
        });
        const w1 = yield* (yield* Workstreams.Workstreams).get("W1" as never);
        expect(w1).toMatchObject({ projectRef: REF, state: "draft", source: { text: "fix: the lab README has a typo", channel: "mcp", by: "k1" } });
        // The workstream pins the chosen template's playbook at creation.
        expect(w1?.playbook).toMatch(/^bugfix@[0-9a-f]{40}$/u);

        const [event] = yield* routedEvents();
        expect(event).toMatchObject({ machineId: "lab-a", projectId: "p1", summary: "W1 → repo-a (bugfix): repo-a holds the lab README (template bugfix from the fix: prefix)" });
        expect(dataOf(event)).toMatchObject({
          workstreamId: "W1",
          template: "bugfix",
          playbook: w1?.playbook,
          usage: [{ kind: "orchestrator", model: "claude-haiku-5-5", ok: true, inputTokens: 120, outputTokens: 30 }],
        });

        expect(yield* submit("fix: the lab README has a typo")).toMatchObject({ workstreamId: "W1", echo: { projectRef: REF, template: "bugfix" } });
        expect(fake.calls()).toHaveLength(1);
        // Only projects the submitter may operate on are offered.
        expect(fake.calls()[0]!.prompt).toContain('"title":"repo-b"');
        expect(fake.calls()[0]!.prompt).not.toContain("repo-c");
      }),
    );
  });

  it("takes the project from @<project> and the caller's project without running the router", async () => {
    const { fake, run } = setup([]);
    await run(
      Effect.gen(function* () {
        expect(yield* submit("@Repo-B research: does caching help")).toMatchObject({
          workstreamId: "W1",
          echo: { projectRef: OTHER, template: "research", reason: "@Repo-B names repo-b; template research from the research: prefix" },
        });
        expect(yield* submit("add a /health endpoint", { ref: REF })).toMatchObject({
          echo: { projectRef: REF, template: "feature", reason: "project given by the caller; template feature by default" },
        });
        expect(yield* submit("compare two caches", { ref: REF, template: "research" })).toMatchObject({
          echo: { template: "research", reason: "project given by the caller; template research given by the caller" },
        });
        const ws = yield* Workstreams.Workstreams;
        const pinned = yield* Effect.forEach(["W1", "W2", "W3"], (id) => Effect.map(ws.get(id as never), (w) => w?.playbook?.split("@")[0]));
        expect(pinned).toEqual(["research", "feature", "research"]);
        expect(fake.calls()).toHaveLength(0);
      }),
    );
  });

  it("refuses an @<project> that matches nothing the submitter may operate on", async () => {
    const { run } = setup([]);
    await run(
      Effect.gen(function* () {
        expect(yield* Effect.flip(submit("@nope add a page"))).toMatchObject({ code: "not_found", message: "No project you may start work in matches @nope." });
        expect(yield* Effect.flip(submit("@repo-c add a page"))).toMatchObject({ code: "not_found" });
      }),
    );
  });

  it("falls back to an unrouted ask after two bad runs, and the human's answer starts the intent there", async () => {
    const { fake, run } = setup([result("repo-a?"), result({ projectRef: THIRD, template: "feature", reason: "x" })]);
    await run(
      Effect.gen(function* () {
        const out = yield* submit("tidy up the docs", { clientRequestId: "req-7" });
        expect(out).toMatchObject({ askId: "A1" });
        expect(fake.calls()).toHaveLength(2);

        const ask = (yield* (yield* Asks).get("A1" as never))!;
        expect(ask.projectRef).toBeUndefined();
        expect(ask).toMatchObject({ kind: "decide", class: "product", state: "open", proceededOnRec: false });
        expect(ask.key).toMatch(/^intake\.route\.tidy-up-the-docs-[0-9a-f]{6}$/u);
        expect(ask.text).toContain('"tidy up the docs"');
        expect([...ask.options!].sort()).toEqual(["repo-a on lab-a", "repo-b on lab-a"]);
        expect(ask.recommendation).toBe(ask.options![0]);
        const [asked] = yield* routedEvents();
        expect(dataOf(asked)).toMatchObject({ askId: "A1", usage: [{ ok: false }, { ok: false }] });
        expect(asked!.machineId).toBeUndefined();

        // A retry before the answer returns the same ask without another run.
        expect(yield* submit("tidy up the docs", { clientRequestId: "req-7" })).toMatchObject({ askId: "A1" });
        expect(fake.calls()).toHaveLength(2);

        yield* TestClock.adjust(Duration.seconds(31));
        const letter = "ab"[ask.options!.indexOf("repo-b on lab-a")]!;
        const replied = yield* reply(`${ask.number} ${letter}`);
        expect(replied.parsed).toBe(true);

        const log = yield* EventLog.EventLog;
        const placed = yield* log.wait({ cursor: asked!.seq, types: ["intake.routed"], timeoutSec: 60 });
        expect(placed.events[0]).toMatchObject({ machineId: "lab-a", projectId: "p2" });
        expect(dataOf(placed.events[0])).toMatchObject({ workstreamId: "W1", askId: "A1", template: "feature", reason: "the human picked it in A1" });
        const w1 = yield* (yield* Workstreams.Workstreams).get("W1" as never);
        expect(w1).toMatchObject({ projectRef: OTHER, source: { text: "tidy up the docs", by: "k1" } });
        expect(w1?.playbook).toMatch(/^feature@/u);
        expect(yield* submit("tidy up the docs", { clientRequestId: "req-7" })).toMatchObject({ workstreamId: "W1", echo: { projectRef: OTHER } });
      }),
    );
  });
});
