import type { WorkstreamId } from "@fleetd/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as EventLog from "../store/EventLog.ts";
import * as LeadRecords from "./LeadRecords.ts";
import * as Leads from "./Leads.ts";
import * as LeadWakes from "./LeadWakes.ts";
import { ask, decision, makeKit, OTHER, REF, runKit } from "./testKit.ts";

const intent = (n: number) => ({ kind: "intent" as const, workstreamId: `W${n}` as WorkstreamId, text: `intent ${n}` });
const advance = (seconds: number) => TestClock.adjust(Duration.seconds(seconds));

describe("LeadWakes", () => {
  it("coalesces triggers into one wake 10 s after the last one, digest first", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF, "Demo");
        yield* (yield* Leads.Leads).start(REF);
        const wakes = yield* LeadWakes.LeadWakes;

        yield* wakes.trigger(REF, intent(1));
        yield* advance(5);
        yield* wakes.trigger(REF, intent(2));
        yield* advance(9);
        yield* wakes.trigger(REF, intent(3));
        yield* advance(9);
        expect(kit.sends).toHaveLength(0);

        yield* advance(1);
        expect(kit.sends).toHaveLength(1);
        const { message, threadId } = kit.sends[0]!;
        expect(threadId).toBe("t1");
        expect(message.startsWith("# fleetd digest: project Demo")).toBe(true);
        const why = message.slice(message.indexOf("## Why you are woken"));
        expect(why).toContain("New intent W1: 'intent 1'. Register it with `fleetd brief create --workstream W1");
        expect(why).toContain("New intent W2");
        expect(why).toContain("New intent W3");

        // Quiet afterwards: nothing is re-sent.
        yield* advance(60);
        expect(kit.sends).toHaveLength(1);
        const lead = yield* (yield* LeadRecords.LeadRecords).leads.get(REF);
        expect(lead?.lastWakeAt).toBe("1970-01-01T00:00:24.000Z");
        const woken = yield* (yield* EventLog.EventLog).wait({ cursor: 0, types: ["lead.woken"], timeoutSec: 0 });
        expect(woken.events.map((e) => e.data)).toEqual([{ triggers: ["intent", "intent", "intent"] }]);
      }),
    );
  });

  it("debounces each lead on its own", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        yield* kit.addProject(OTHER);
        const leads = yield* Leads.Leads;
        yield* leads.start(REF);
        yield* leads.start(OTHER);
        const wakes = yield* LeadWakes.LeadWakes;
        yield* wakes.trigger(REF, intent(1));
        yield* advance(6);
        yield* wakes.trigger(OTHER, intent(2));
        yield* advance(4);
        expect(kit.sends.map((s) => s.threadId)).toEqual(["t1"]);
        yield* advance(6);
        expect(kit.sends.map((s) => s.threadId)).toEqual(["t1", "t2"]);
      }),
    );
  });

  it("wakes the lead with the answer inline when the ledger reports one", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        yield* (yield* Leads.Leads).start(REF);
        const d1 = decision(1, "api.health.path", "/healthz", { askId: "A1" as never });
        kit.decisions.set("D1", d1);
        yield* kit.answer({ ask: ask(1, "api.health.path", { state: "answered", decisionId: d1.decisionId }), decision: d1 });
        yield* kit.answer({ ask: ask(2, "db.engine", { state: "withdrawn" }) });
        yield* advance(10);
        expect(kit.sends).toHaveLength(1);
        const message = kit.sends[0]!.message;
        expect(message).toContain("## Answers since your last wake\n- A1 api.health.path → /healthz (D1)\n- A2 db.engine: dropped by the human");
        expect(message).toContain("The human settled 2 of your asks");
      }),
    );
  });

  it("drops a wake for a project without a lead, and leaves lastWakeAt alone when delivery fails", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        const wakes = yield* LeadWakes.LeadWakes;
        yield* wakes.trigger(REF, intent(1));
        yield* advance(10);
        expect(kit.sends).toHaveLength(0);

        yield* (yield* Leads.Leads).start(REF);
        kit.setOffline(true);
        yield* wakes.trigger(REF, intent(2));
        yield* advance(10);
        expect(kit.sends).toHaveLength(0);
        expect((yield* (yield* LeadRecords.LeadRecords).leads.get(REF))?.lastWakeAt).toBeUndefined();
      }),
    );
  });
});
