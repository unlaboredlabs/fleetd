import type { DecisionKey, LeadCall, WorkstreamId } from "@fleetd/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { Decisions } from "../ledger/Decisions.ts";
import { DECIDE_YOURSELF } from "../ledger/Asks.ts";
import { leadBy } from "../link/LeadCalls.ts";
import { Tasks } from "../tasks/Tasks.ts";
import * as LeadCallHandler from "./LeadCallHandler.ts";
import * as Leads from "./Leads.ts";
import * as Workstreams from "./Workstreams.ts";
import { HUMAN, makeKit, OTHER, REF, reply, runKit } from "./testKit.ts";

const caller = { projectRef: REF, by: leadBy(REF), cwd: "/w/p1" };
const brief = {
  goal: "Serve /healthz",
  why: "Uptime checks",
  pointers: [],
  constraints: [],
  doneWhen: [{ type: "http", url: "http://localhost/healthz", status: 200 }],
  tier: "S",
};
const healthAsk = {
  op: "ask",
  kind: "decide",
  key: "api.health.path",
  class: "product",
  text: "Path?",
  recommendation: "/healthz",
  blocks: "nothing",
  proceededOnRec: true,
} as LeadCall;

// Task calls are covered in tasks/LeadTaskCalls.test.ts, over the real task service.
const noTasks = Tasks.of({
  spawn: () => Effect.die("no tasks in this kit"),
  message: () => Effect.die("no tasks in this kit"),
  cancel: () => Effect.die("no tasks in this kit"),
  get: () => Effect.succeed(undefined),
  list: () => Effect.succeed([]),
});

const setup = Effect.gen(function* () {
  const handler = yield* LeadCallHandler.make.pipe(Effect.provideService(Tasks, noTasks));
  const call = (c: LeadCall) => handler.handle(caller, c);
  return { call, refused: (c: LeadCall) => Effect.flip(call(c)) };
});

describe("LeadCallHandler", () => {
  it("runs the M3 loop for a lead: brief, ask, answer, auto-answer, refusal", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF, "Demo");
        yield* (yield* Leads.Leads).start(REF);
        const { workstreamId } = yield* (yield* Workstreams.Workstreams).intake({
          ref: REF,
          text: "add a /health endpoint",
          clientRequestId: "c1",
          channel: "mcp",
          by: "lab",
        });
        const { call, refused } = yield* setup;

        const frozen = yield* call({ op: "brief_create", workstreamId, brief } as LeadCall);
        expect(frozen).toMatchObject({ op: "brief_create", workstreamId, state: "running" });

        const filed = yield* call(healthAsk);
        expect(filed).toMatchObject({ op: "ask", state: "open", askId: "A1" });
        expect((yield* reply("1 go")).echo).toBe("Logged: 1 → /healthz (D1)");

        const again = yield* call(healthAsk);
        expect(again).toMatchObject({ op: "ask", state: "auto", decision: { decisionId: "D1", value: "/healthz", source: "human" } });

        const naming = yield* refused({ ...healthAsk, key: "api.health.name", class: "naming" } as LeadCall);
        expect(naming.code).toBe("invalid");
        expect(naming.message).toContain(DECIDE_YOURSELF);

        expect(yield* call({ op: "status_set", text: "brief frozen" } as LeadCall)).toMatchObject({ workstreamId });
        const search = yield* call({ op: "decisions_search", query: "health path" } as LeadCall);
        expect(search).toMatchObject({ op: "decisions_search", decisions: [{ decisionId: "D1" }] });
      }),
    );
  });

  it("decides at workstream scope by default, as the lead, and refuses another project's workstream", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        yield* kit.addProject(OTHER);
        const ws = yield* Workstreams.Workstreams;
        const { call, refused } = yield* setup;
        const decide = { op: "decide", key: "ui.color", value: "blue", scope: "workstream" } as LeadCall;

        expect((yield* refused(decide)).fix).toContain("--scope project");
        const mine = yield* ws.intake({ ref: REF, text: "mine", clientRequestId: "a", channel: "mcp", by: "lab" });
        const theirs = yield* ws.intake({ ref: OTHER, text: "theirs", clientRequestId: "b", channel: "mcp", by: "lab" });

        const decided = yield* call(decide);
        expect(decided).toMatchObject({
          decision: { scope: { kind: "workstream", workstreamId: mine.workstreamId }, source: "lead", by: "lead:lab-a/p1" },
        });
        const project = yield* call({ ...decide, scope: "project" } as LeadCall);
        expect(project).toMatchObject({ decision: { scope: { kind: "project", projectRef: REF } } });

        expect((yield* refused({ ...decide, workstreamId: theirs.workstreamId } as LeadCall)).code).toBe("not_found");
        expect((yield* refused({ ...healthAsk, workstreamId: theirs.workstreamId } as LeadCall)).code).toBe("not_found");
        expect((yield* refused({ op: "status_set", text: "x", workstreamId: "W99" as WorkstreamId } as LeadCall)).code).toBe("not_found");
      }),
    );
  });
});

describe("decision wakes", () => {
  it("wakes the lead when someone other than the lead records a decision in its project, not for answers or lead decisions", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        yield* (yield* Leads.Leads).start(REF);
        const decisions = yield* Decisions;
        const record = (key: string, source: "human" | "lead" | "agent", scope: "project" | "global" = "project") =>
          decisions.record(
            {
              key: key as DecisionKey,
              scope: scope === "project" ? { kind: "project", projectRef: REF } : { kind: "global" },
              value: "v",
              ...(scope === "project" ? { projectRef: REF } : {}),
            },
            { source, by: source === "lead" ? leadBy(REF) : "lab" },
          );
        yield* record("by.lead", "lead");
        yield* record("by.agent", "agent");
        yield* record("everywhere", "human", "global");
        yield* Effect.repeat(Effect.yieldNow, { times: 20 });
        yield* TestClock.adjust(Duration.seconds(10));
        expect(kit.sends).toHaveLength(1);
        const why = kit.sends[0]!.message.slice(kit.sends[0]!.message.indexOf("## Why you are woken"));
        expect(why).toContain("Agent lab, for the human, recorded D2: by.agent = v (project)");
        expect(why).not.toContain("by.lead");
        expect(why).not.toContain("everywhere");

        // An inbox answer wakes through the AnswerSink only, so it is listed once.
        yield* (yield* setup).call(healthAsk);
        yield* reply("1 go", HUMAN);
        yield* Effect.repeat(Effect.yieldNow, { times: 20 });
        yield* TestClock.adjust(Duration.seconds(10));
        expect(kit.sends).toHaveLength(2);
        expect(kit.sends[1]!.message).not.toContain(" recorded D");
      }),
    );
  });
});
