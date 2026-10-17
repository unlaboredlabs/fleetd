import type { WorkstreamId } from "@fleetd/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as EventLog from "../store/EventLog.ts";
import * as LeadRecords from "./LeadRecords.ts";
import * as Leads from "./Leads.ts";
import * as LeadWakes from "./LeadWakes.ts";
import { fileAsk, makeKit, OTHER, REF, reply, runKit } from "./testKit.ts";

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

  it("wakes 60 s after the first trigger even while triggers keep arriving, then starts a fresh window", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        yield* (yield* Leads.Leads).start(REF);
        const wakes = yield* LeadWakes.LeadWakes;
        // A trigger every 8 s never leaves a 10 s quiet window.
        for (let i = 1; i <= 7; i++) {
          yield* wakes.trigger(REF, intent(i));
          yield* advance(8);
        }
        // t = 56 s: seven triggers in, none sent.
        expect(kit.sends).toHaveLength(0);
        yield* wakes.trigger(REF, intent(8));
        yield* advance(3);
        expect(kit.sends).toHaveLength(0);
        yield* advance(1);
        // t = 60 s: the max wait fires with all eight.
        expect(kit.sends).toHaveLength(1);
        expect(kit.sends[0]!.message.match(/New intent W\d+/gu)).toHaveLength(8);

        // The next trigger opens a new window measured from itself.
        yield* wakes.trigger(REF, intent(9));
        yield* advance(9);
        expect(kit.sends).toHaveLength(1);
        yield* advance(1);
        expect(kit.sends).toHaveLength(2);
        expect(kit.sends[1]!.message.match(/New intent W\d+/gu)).toEqual(["New intent W9"]);
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

  it("wakes the lead with the human's answers inline after an inbox reply", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        yield* (yield* Leads.Leads).start(REF);
        yield* fileAsk("api.health.path", { text: "Path?", recommendation: "/healthz" });
        yield* fileAsk("db.engine");
        expect((yield* reply("1 go 2 nvm")).echo).toBe("Logged: 1 → /healthz (D1), 2 → dropped");
        yield* advance(9);
        expect(kit.sends).toHaveLength(0);
        yield* advance(1);
        expect(kit.sends).toHaveLength(1);
        const message = kit.sends[0]!.message;
        expect(message).toContain("## Answers since your last wake\n- A1 api.health.path → /healthz (D1)\n- A2 db.engine: dropped by the human");
        expect(message).toContain("- D1 api.health.path = /healthz (project, human)");
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
