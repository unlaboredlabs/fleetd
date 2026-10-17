import type { AskId, WorkstreamId } from "@fleetd/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as EventLog from "../store/EventLog.ts";
import { briefHash, canonicalJson } from "./brief.ts";
import * as Leads from "./Leads.ts";
import * as Workstreams from "./Workstreams.ts";
import { ask, decision, makeKit, OTHER, REF, runKit } from "./testKit.ts";

const brief = {
  goal: "Serve a health endpoint",
  why: "Uptime probes need it",
  pointers: ["apps/api/src/server.ts"],
  constraints: [],
  doneWhen: [{ type: "http", url: "http://lab:4710/healthz", status: 200 }],
  tier: "S",
};

const intake = (text: string, clientRequestId = text) =>
  Effect.flatMap(Workstreams.Workstreams, (w) => w.intake({ ref: REF, text, clientRequestId, channel: "mcp", by: "k1" }));

describe("brief hash", () => {
  it("ignores key order and whitespace, and changes with any value", () => {
    const reordered = { tier: "S", doneWhen: [{ status: 200, url: "http://lab:4710/healthz", type: "http" }], constraints: [], pointers: ["apps/api/src/server.ts"], why: "Uptime probes need it", goal: "Serve a health endpoint" };
    expect(canonicalJson(reordered)).toBe(canonicalJson(brief));
    expect(briefHash(reordered as never)).toBe(briefHash(brief as never));
    expect(briefHash(brief as never)).toMatch(/^[0-9a-f]{64}$/u);
    expect(briefHash({ ...brief, tier: "M" } as never)).not.toBe(briefHash(brief as never));
  });
});

describe("Workstreams", () => {
  it("intake creates one draft per request id and wakes the lead with the intent", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        const first = yield* intake("add a /health endpoint\nwith a JSON body", "req-1");
        expect(first.workstreamId).toBe("W1");
        expect(first.next).toContain("lead_start");
        // No lead yet, so the wake is dropped; the lead's first digest lists W1 instead.
        yield* TestClock.adjust(Duration.seconds(10));
        expect(kit.sends).toHaveLength(0);
        yield* (yield* Leads.Leads).start(REF);
        expect(kit.launches[0]!.input.prompt).toContain("- W1 draft: add a /health endpoint");
        expect((yield* intake("ignored on retry", "req-1")).workstreamId).toBe("W1");
        expect((yield* intake("second", "req-2")).workstreamId).toBe("W2");

        const w1 = yield* (yield* Workstreams.Workstreams).get("W1" as WorkstreamId);
        expect(w1).toMatchObject({ state: "draft", title: "add a /health endpoint", source: { text: "add a /health endpoint\nwith a JSON body", channel: "mcp", by: "k1" } });

        yield* TestClock.adjust(Duration.seconds(10));
        expect(kit.sends).toHaveLength(1);
        const why = kit.sends[0]!.message.slice(kit.sends[0]!.message.indexOf("## Why you are woken"));
        expect(why).toBe("## Why you are woken\n- New intent W2: 'second'. Register it with `fleetd brief create --workstream W2 --json '<Brief>'`.");

        const created = yield* (yield* EventLog.EventLog).wait({ cursor: 0, types: ["workstream.created"], timeoutSec: 0 });
        expect(created.events).toHaveLength(2);
        expect((yield* Effect.flip(Effect.flatMap(Workstreams.Workstreams, (w) => w.intake({ ref: OTHER, text: "x", clientRequestId: "r", channel: "app", by: "human" })))).code).toBe("not_found");
      }),
    );
  });

  it("brief create validates, freezes the hash, moves draft to running and is idempotent", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        yield* kit.addProject(OTHER);
        yield* intake("health");
        const ws = yield* Workstreams.Workstreams;
        const W1 = "W1" as WorkstreamId;

        const noChecks = yield* Effect.flip(ws.briefCreate(REF, { workstreamId: W1, brief: { ...brief, doneWhen: [] } }));
        expect(noChecks.code).toBe("invalid");
        const noTier = yield* Effect.flip(ws.briefCreate(REF, { workstreamId: W1, brief: { ...brief, tier: "XL" } }));
        expect(noTier.code).toBe("invalid");
        expect((yield* Effect.flip(ws.briefCreate(OTHER, { workstreamId: W1, brief }))).code).toBe("forbidden");
        expect((yield* ws.get(W1))?.state).toBe("draft");

        const frozen = yield* ws.briefCreate(REF, { workstreamId: W1, brief });
        expect(frozen).toMatchObject({ op: "brief_create", workstreamId: "W1", state: "running", briefHash: briefHash(brief as never) });
        expect(yield* ws.get(W1)).toMatchObject({ state: "running", briefHash: frozen.briefHash, brief });

        // Same brief, keys in another order: unchanged, not a change.
        const again = yield* ws.briefCreate(REF, { workstreamId: W1, brief: Object.fromEntries(Object.entries(brief).reverse()) });
        expect(again.briefHash).toBe(frozen.briefHash);
        expect(again.next).toContain("already frozen");

        const running = yield* (yield* EventLog.EventLog).wait({ cursor: 0, types: ["workstream.running"], timeoutSec: 0 });
        expect(running.events.map((e) => e.data)).toEqual([{ workstreamId: "W1", briefHash: frozen.briefHash }]);
      }),
    );
  });

  it("changes a frozen brief only under a human-answered ask, once per ask", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        yield* intake("health");
        const ws = yield* Workstreams.Workstreams;
        const W1 = "W1" as WorkstreamId;
        yield* ws.briefCreate(REF, { workstreamId: W1, brief });
        const changed = { ...brief, tier: "M" };

        const refused = yield* Effect.flip(ws.briefCreate(REF, { workstreamId: W1, brief: changed }));
        expect(refused).toMatchObject({ code: "invalid" });
        expect(refused.fix).toContain("--amend");

        kit.asks.set("A1", ask(1, "w1.brief"));
        kit.asks.set("A2", ask(2, "w1.brief", { state: "answered", decisionId: "D2" as never }));
        kit.decisions.set("D2", decision(2, "w1.brief", "go", { source: "lead" }));
        kit.asks.set("A3", ask(3, "w1.brief", { state: "answered", decisionId: "D3" as never }));
        kit.decisions.set("D3", decision(3, "w1.brief", "go"));
        for (const id of ["A1", "A2", "A9"]) {
          expect((yield* Effect.flip(ws.briefCreate(REF, { workstreamId: W1, brief: changed, amend: id as AskId }))).code).toBe("invalid");
        }
        expect((yield* ws.get(W1))?.brief?.tier).toBe("S");

        const amended = yield* ws.briefCreate(REF, { workstreamId: W1, brief: changed, amend: "A3" as AskId });
        expect(amended).toMatchObject({ state: "running", briefHash: briefHash(changed as never) });
        const reuse = yield* Effect.flip(ws.briefCreate(REF, { workstreamId: W1, brief: { ...brief, tier: "L" }, amend: "A3" as AskId }));
        expect(reuse.message).toContain("already used");
      }),
    );
  });

  it("status set writes the headline, picking the only open workstream when none is named", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        const ws = yield* Workstreams.Workstreams;
        expect((yield* Effect.flip(ws.statusSet(REF, { text: "hi" }))).code).toBe("invalid");
        yield* intake("one");
        expect(yield* ws.statusSet(REF, { text: "writing the endpoint" })).toMatchObject({ workstreamId: "W1" });
        yield* intake("two");
        expect((yield* Effect.flip(ws.statusSet(REF, { text: "ambiguous" }))).fix).toContain("--workstream");
        yield* ws.statusSet(REF, { text: "PR open", workstreamId: "W2" as WorkstreamId });
        expect(yield* ws.get("W1" as WorkstreamId)).toMatchObject({ headline: "writing the endpoint" });
        expect(yield* ws.get("W2" as WorkstreamId)).toMatchObject({ headline: "PR open", headlineAt: "1970-01-01T00:00:00.000Z" });
      }),
    );
  });
});
