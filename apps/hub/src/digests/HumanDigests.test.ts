import type { DecisionKey, HubEvent, MachineId } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { Decisions } from "../ledger/Decisions.ts";
import * as Workstreams from "../leads/Workstreams.ts";
import { fileAsk, makeKit, OTHER, REF, runKit } from "../leads/testKit.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HumanDigests from "./HumanDigests.ts";

const digests = (cursor: number) =>
  Effect.flatMap(EventLog.EventLog, (log) => log.wait({ cursor, types: ["digest.ready"], timeoutSec: 0 }));

/** Builds the digest service (and its scheduler) now, after the test has set the clock and policy. */
const startDigests = Effect.map(Layer.build(HumanDigests.layer), (context) => Context.get(context, HumanDigests.HumanDigests));

const recordTz = (tz: string) =>
  Effect.flatMap(Decisions, (d) => d.record({ key: HumanDigests.POLICY_TZ_KEY as DecisionKey, scope: { kind: "global" }, value: tz }, { source: "human", by: "lab" }));

describe("human digests", () => {
  it("emits digest.ready at 09:00 and 18:00 in policy.tz, and renders on demand", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.scoped(Effect.gen(function* () {
        yield* kit.addProject(REF, "Demo");
        // The TestClock starts at 1970-01-01T00:00Z; New York is then on EST (UTC-5).
        yield* recordTz("America/New_York");
        yield* (yield* Workstreams.Workstreams).intake({ ref: REF, text: "add a /health endpoint", clientRequestId: "c1", channel: "mcp", by: "lab" });
        yield* fileAsk("api.health.path", { text: "Path?", recommendation: "/healthz" });
        const service = yield* startDigests;
        const now = yield* service.render();
        expect(now.text).toContain("1 need you");
        expect(now.text).toContain("[product] Demo: Path?");
        expect(now.text).toContain("Running: W1 Demo: add a /health endpoint");

        yield* TestClock.adjust(Duration.minutes(14 * 60 - 1));
        expect((yield* digests(0)).events).toHaveLength(0);
        yield* TestClock.adjust(Duration.minutes(1));
        const first = (yield* digests(0)).events;
        expect(first.map((e: HubEvent) => e.at)).toEqual(["1970-01-01T14:00:00.000Z"]);
        expect(first[0]!.data).toMatchObject({ text: expect.stringContaining("fleetd digest · Thu 1 Jan, 09:00") });

        // The zone changes to UTC: the evening digest follows it, at 18:00 UTC.
        yield* recordTz("UTC");
        yield* TestClock.adjust(Duration.hours(4));
        expect((yield* digests(first[0]!.seq)).events.map((e: HubEvent) => e.at)).toEqual(["1970-01-01T18:00:00.000Z"]);
      })),
    );
  });

  it("filters to the caller's machines and keeps the event within the 2 KB cap", async () => {
    const kit = makeKit();
    await runKit(
      kit,
      Effect.scoped(Effect.gen(function* () {
        yield* kit.addProject(REF, "Mine");
        yield* kit.addProject({ ...OTHER, machineId: "lab-b" as MachineId }, "Theirs");
        const ws = yield* Workstreams.Workstreams;
        for (let i = 0; i < 30; i++) {
          yield* ws.intake({ ref: REF, text: `intent number ${i} with a fairly long description of the work`, clientRequestId: `m${i}`, channel: "mcp", by: "lab" });
        }
        yield* ws.intake({ ref: { ...OTHER, machineId: "lab-b" as MachineId }, text: "secret plan", clientRequestId: "o", channel: "mcp", by: "lab" });
        const service = yield* startDigests;

        const all = (yield* service.render()).text;
        expect(all).toContain("secret plan");
        expect((yield* service.render((m) => m === REF.machineId)).text).not.toContain("secret plan");

        const data = HumanDigests.eventData(all, "2026-10-17T09:00:00.000Z");
        expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(2048);
        expect(data).toMatchObject({ truncated: true, fullText: "digest_get" });
        expect(all.startsWith(data.text.slice(0, -2))).toBe(true);
      })),
    );
  });
});
