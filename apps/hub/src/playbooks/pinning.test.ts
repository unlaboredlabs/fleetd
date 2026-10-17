// Pinning at intake, the floor at brief freeze, lead instructions in wakes and digests, and research verdicts, on the
// leads test kit.
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { PlaybookName, WorkstreamId } from "@fleetd/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as Leads from "../leads/Leads.ts";
import * as LeadWakes from "../leads/LeadWakes.ts";
import { makeKit, REF, runKit } from "../leads/testKit.ts";
import * as Workstreams from "../leads/Workstreams.ts";
import * as EventLog from "../store/EventLog.ts";
import { bundledDir } from "./load.ts";
import { Playbooks } from "./Playbooks.ts";
import { Research } from "./Research.ts";

const intake = (text: string, template?: PlaybookName) =>
  Effect.flatMap(Workstreams.Workstreams, (w) =>
    w.intake({ ref: REF, text, clientRequestId: text, channel: "mcp", by: "k1", ...(template === undefined ? {} : { template }) }),
  );

const base = { goal: "g", why: "w", pointers: [], constraints: [] };
const prMerged = { type: "pr_merged", repo: "wynn-dev/lab" };
const W1 = "W1" as WorkstreamId;

describe("playbook pinning", () => {
  it("pins name@<git blob sha> at intake, puts the instructions in the wake and digest, and checks the brief against it", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        yield* (yield* Leads.Leads).start(REF);
        const sha = execFileSync("git", ["hash-object", path.join(bundledDir(), "bugfix.md")], { encoding: "utf8" }).trim();
        const created = yield* intake("fix: the lab README has a typo", "bugfix");
        expect(created.playbook).toBe(`bugfix@${sha}`);
        const ws = yield* Workstreams.Workstreams;
        expect((yield* ws.get(W1))?.playbook).toBe(`bugfix@${sha}`);
        expect((yield* intake("no template")).playbook).toBeUndefined();

        yield* TestClock.adjust(Duration.seconds(10));
        const wake = kit.sends[0]!.message;
        const instructions = (yield* Playbooks).current("bugfix").playbook.leadInstructions;
        expect(wake).toContain("- W1 draft (bugfix): fix: the lab README has a typo");
        expect(wake).toContain(`## Playbooks: follow these for their workstreams\n- bugfix (W1): ${instructions}`);
        expect(wake).toContain(`- New intent W1: 'fix: the lab README has a typo'.`);
        expect(wake).toContain('It follows the bugfix playbook; its instructions are under "Playbooks" above.');

        const refused = yield* Effect.flip(ws.briefCreate(REF, { workstreamId: W1, brief: { ...base, doneWhen: [prMerged] } }));
        expect(refused).toMatchObject({ code: "invalid", message: "bugfix needs a failing repro check (type test or cmd)" });
        expect((yield* ws.get(W1))?.state).toBe("draft");

        // No tier: the playbook's default applies.
        const repro = { type: "cmd", machineId: "lab-a", argv: ["grep", "-q", "teh", "README.md"], expectExit: 1 };
        yield* ws.briefCreate(REF, { workstreamId: W1, brief: { ...base, doneWhen: [repro, prMerged] } });
        expect(yield* ws.get(W1)).toMatchObject({ state: "running", brief: { tier: "S" } });
      }),
    );
  });

  it("puts the instructions inline when the digest does not show them", () => {
    const lines = LeadWakes.triggerLines([
      { kind: "intent", workstreamId: W1, text: "research: is the cache worth it", playbook: { name: "research", leadInstructions: "Measure  both." } },
    ]);
    expect(lines[1]).toBe("  It follows the research playbook: Measure both.");
  });
});

describe("research verdicts", () => {
  const rule = { better: "higher", goAtLeast: 0.1, stopBelow: 0.02 };
  const researchBrief = {
    ...base,
    doneWhen: [{ type: "judge", criteria: "report the hit rate for baseline and candidate" }],
    baseline: "no cache",
    metric: "hit rate",
    decisionRule: rule,
    budget: { agentHours: 2 },
  };

  it("refuses a research brief without its pre-registered fields", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        yield* intake("research: is a cache worth it", "research");
        const ws = yield* Workstreams.Workstreams;
        const { baseline: _b, decisionRule: _r, ...missing } = researchBrief;
        const refused = yield* Effect.flip(ws.briefCreate(REF, { workstreamId: W1, brief: missing }));
        expect(refused.message).toBe("a research brief needs baseline, metric, decisionRule and budget.agentHours; missing baseline, decisionRule");
      }),
    );
  });

  it("computes the verdict from the frozen rule, stores it and ends the workstream done, STOP included", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        yield* intake("research: is a cache worth it", "research");
        yield* intake("feature: a cache", "feature");
        const ws = yield* Workstreams.Workstreams;
        yield* ws.briefCreate(REF, { workstreamId: W1, brief: researchBrief });
        const research = yield* Research;

        const { workstream, text } = yield* research.recordVerdict(W1, { baseline: 0.5, candidate: 0.51 });
        expect(workstream).toMatchObject({ state: "done", outcome: "stop", verdict: { outcome: "stop", rule, metricValues: { baseline: 0.5, candidate: 0.51 } } });
        expect(yield* ws.get(W1)).toEqual(workstream);
        expect(text).toBe(
          "W1 research verdict STOP: candidate 0.51 vs baseline 0.5 on hit rate (higher is better): improvement 0.01, below the stop line 0.02. STOP is a success: the question is answered.",
        );
        const events = yield* (yield* EventLog.EventLog).wait({ cursor: 0, types: ["research.verdict", "workstream.done"], timeoutSec: 0 });
        expect(events.events.map((e) => [e.type, e.data])).toEqual([
          ["research.verdict", { workstreamId: "W1", outcome: "stop", metricValues: { baseline: 0.5, candidate: 0.51 } }],
          ["workstream.done", { workstreamId: "W1" }],
        ]);

        // Final: later numbers change nothing.
        expect((yield* research.recordVerdict(W1, { baseline: 0.5, candidate: 0.9 })).workstream.outcome).toBe("stop");
        expect((yield* Effect.flip(research.recordVerdict("W2" as WorkstreamId, { baseline: 0, candidate: 1 }))).message).toContain("not a research workstream");
      }),
    );
  });
});
