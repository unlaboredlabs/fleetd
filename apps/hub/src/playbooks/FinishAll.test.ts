// Finish-all on the leads test kit with a fake node and a fake `gh`: the ranked inventory, child spawns held to a
// value source and the policy's limit, and the idle finish line with its way back.
import type { PolicyFile, WorkstreamId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import * as GitHub from "../checks/GitHub.ts";
import { type CommandInput, type CommandOutcome, NodeCommands } from "../checks/NodeCommands.ts";
import { Policies } from "../leases/Policy.ts";
import * as LeadRecords from "../leads/LeadRecords.ts";
import * as LeadWakes from "../leads/LeadWakes.ts";
import { fileAsk, makeKit, REF } from "../leads/testKit.ts";
import * as Workstreams from "../leads/Workstreams.ts";
import { renderHumanDigest } from "../ledger/HumanDigest.ts";
import * as EventLog from "../store/EventLog.ts";
import { FinishAll, layer as finishAllLayer } from "./FinishAll.ts";
import { FINISH_ALL_IDLE } from "./finishAllRules.ts";

const LEAD = { projectRef: REF, by: "lead:lab-a/p1" };
const POLICY = { areas: { all: ["**"] }, finishAll: { maxChildren: 2 } } as unknown as PolicyFile;
const issue = (number: number, title: string, pr = false) => ({ number, title, html_url: `https://github.com/wynn-dev/lab/issues/${number}`, ...(pr ? { pull_request: {} } : {}) });

const makeFinishAllKit = () => {
  const kit = makeKit();
  let issues: Array<object> | "down" = [];
  let todo: CommandOutcome = { exitCode: 1, outputTail: "", timedOut: false };
  const node = NodeCommands.of({
    run: (_machineId, input: CommandInput) =>
      Effect.succeed(
        input.argv.join(" ") === "git remote get-url origin" ? { exitCode: 0, outputTail: "git@github.com:Wynn-Dev/lab.git\n", timedOut: false } : todo,
      ),
    attach: () => Effect.void,
    resolve: () => Effect.void,
  });
  const gh: GitHub.GhRunner = (args) =>
    Effect.succeed(
      issues === "down"
        ? { exitCode: 1, stdout: "", stderr: "gh: API rate limit exceeded" }
        : args.at(-1)!.startsWith("repos/wynn-dev/lab/issues?state=open")
          ? { exitCode: 0, stdout: JSON.stringify(issues), stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" },
    );
  const layer = finishAllLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(NodeCommands, node),
        GitHub.layer(gh),
        Layer.succeed(Policies, Policies.of({ get: () => Effect.succeed(POLICY), invalidate: () => Effect.void })),
      ),
    ),
    Layer.provideMerge(kit.layer),
  );
  return {
    kit,
    layer,
    setIssues: (value: typeof issues) => void (issues = value),
    setTodo: (value: CommandOutcome) => void (todo = value),
  };
};

const run = <A, E>(k: ReturnType<typeof makeFinishAllKit>, effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof makeFinishAllKit>["layer"]>>) =>
  Effect.runPromise(Effect.scoped(Effect.provide(effect, k.layer)));

const W = (n: number) => `W${n}` as WorkstreamId;

describe("finish-all", () => {
  it("inventories ranked work, spawns children only for value sources up to the limit, and goes idle when nothing is left", () => {
    const k = makeFinishAllKit();
    return run(
      k,
      Effect.gen(function* () {
        yield* k.kit.addProject(REF, "lab");
        const finishAll = yield* FinishAll;
        const workstreams = yield* Workstreams.Workstreams;
        const records = yield* LeadRecords.LeadRecords;

        expect((yield* Effect.flip(finishAll.spawn(LEAD, { text: "fix it", serves: "issue:#3" }))).message).toBe(
          "Your project has no open finish-all workstream; only one spawns child workstreams.",
        );
        yield* workstreams.intake({ ref: REF, text: "finish: everything open", clientRequestId: "r1", channel: "app", by: "human", template: "finish-all" });

        k.setIssues([issue(3, "Login redirect loops"), issue(4, "a PR, not an issue", true)]);
        k.setTodo({ exitCode: 0, outputTail: "src/a.ts:2\nsrc/b.ts:1\n", timedOut: false });
        yield* fileAsk("api.health.path");
        const first = yield* finishAll.inventory(LEAD);
        expect(first).toMatchObject({ spawnable: 1, idle: false });
        expect(first.text).toBe(
          [
            "Inventory of lab (lab-a/p1), ranked; finish-all W1 has 0 of at most 2 open children:",
            "1. issue:#3 — wynn-dev/lab#3 Login redirect loops [open issue]",
            "Without a value source (never a child):",
            "- A1 open ask api.health.path: api.health.path? (the human answers it)",
            "- 3 TODO/FIXME markers (`git grep -I -c -w -E TODO|FIXME`): file an issue for one worth doing",
          ].join("\n"),
        );

        // Children need a value source, one child per source, and at most finishAll.maxChildren open.
        expect(yield* Effect.flip(finishAll.spawn(LEAD, { text: "answer it", serves: "ask:A1" }))).toMatchObject({
          message: "'ask:A1' is not a value source a child can serve.",
        });
        expect((yield* Effect.flip(finishAll.spawn(LEAD, { text: "x", serves: "done:0" }))).message).toBe("W1 has no done-when check done:0.");
        expect(yield* finishAll.spawn(LEAD, { text: "Fix the login redirect loop", serves: "issue:#3" })).toMatchObject({ workstreamId: "W2", parent: "W1" });
        expect((yield* Effect.flip(finishAll.spawn(LEAD, { text: "again", serves: "issue:#3" }))).message).toBe("W2 already serves issue:#3.");
        const child = yield* finishAll.spawn(LEAD, { text: "The CLI crashes on --help", serves: "defect:fleetd --help exits 1" });
        expect(child.playbook?.startsWith("bugfix@")).toBe(true);
        expect((yield* Effect.flip(finishAll.spawn(LEAD, { text: "more", serves: "defect:another" }))).message).toBe(
          "W1 already has 2 open children, the most finishAll.maxChildren allows (2).",
        );
        expect((yield* workstreams.get(W(2)))?.parent).toEqual({ workstreamId: "W1", serves: "issue:#3" });

        // Served items are in progress, and open children keep it from idling.
        const busy = yield* finishAll.inventory(LEAD);
        expect(busy).toMatchObject({ spawnable: 0, idle: false });
        expect(busy.text).toContain("1. issue:#3 — wynn-dev/lab#3 Login redirect loops [open issue] (in progress: W2)");
        const digest = yield* (yield* LeadWakes.LeadWakes).digest(REF);
        expect(digest).toContain("- W2 draft (feature, child of W1 for issue:#3): Fix the login redirect loop");

        for (const id of [W(2), W(3)]) {
          const stored = (yield* records.workstreams.get(id))!;
          yield* records.workstreams.put({ ...stored, workstream: { ...stored.workstream, state: "done" } });
        }
        k.setIssues([]);
        k.setTodo({ exitCode: 1, outputTail: "", timedOut: false });

        // Issues that cannot be read are not "nothing left".
        k.setIssues("down");
        const unknown = yield* finishAll.inventory(LEAD);
        expect(unknown.idle).toBe(false);
        expect(unknown.text).toContain("Could not read open issues of wynn-dev/lab: gh api repos/wynn-dev/lab/issues");

        k.setIssues([]);
        const cursor = yield* (yield* EventLog.EventLog).head();
        const idle = yield* finishAll.inventory(LEAD);
        expect(idle).toMatchObject({ spawnable: 0, idle: true });
        expect(idle.text).toContain(`${FINISH_ALL_IDLE}; W1 is idle.`);
        const w1 = (yield* workstreams.get(W(1)))!;
        expect(w1.state).toBe("idle");
        const events = yield* (yield* EventLog.EventLog).wait({ cursor, types: ["workstream.state"], timeoutSec: 0 });
        expect(events.events.map((e) => e.summary)).toEqual([`W1 is idle: ${FINISH_ALL_IDLE}`]);
        expect(yield* (yield* LeadWakes.LeadWakes).digest(REF)).toContain(`- W1 idle (finish-all): finish: everything open\n  ${FINISH_ALL_IDLE}`);
        const human = renderHumanDigest({ nowMs: 0, tz: "UTC", asks: [], workstreams: [w1], decidedWithoutYou: [], projectNames: new Map([["lab-a/p1", "lab"]]) });
        expect(human).toContain(`Idle: W1 lab: finish: everything open · ${FINISH_ALL_IDLE}`);

        // The way back: new work with a value source reopens it.
        k.setIssues([issue(9, "Docs link is broken")]);
        expect(yield* finishAll.inventory(LEAD)).toMatchObject({ spawnable: 1, idle: false });
        expect((yield* workstreams.get(W(1)))?.state).toBe("draft");
      }),
    );
  });
});
