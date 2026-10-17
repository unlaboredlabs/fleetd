import crypto from "node:crypto";
import type { DecisionKey, HubEvent } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as Auth from "../auth/Auth.ts";
import { LEAD, makeKit, REF } from "../leads/testKit.ts";
import { Asks } from "../ledger/Asks.ts";
import { Decisions } from "../ledger/Decisions.ts";
import * as EventLog from "../store/EventLog.ts";
import { Push, make } from "./Push.ts";
import { decryptPayload, generateVapidKeys, type PushRequest } from "./webPush.ts";

/** A browser's side of one subscription: its keys, and what its push service received. */
const device = (endpoint: string) => {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    input: { endpoint, keys: { p256dh: ecdh.getPublicKey("base64url"), auth: auth.toString("base64url") }, deviceName: "phone" },
    open: (request: PushRequest) => decryptPayload(request.body, { privateKey: ecdh.getPrivateKey(), auth }).toString(),
  };
};

const setup = () => {
  const kit = makeKit();
  const sent: Array<PushRequest> = [];
  const status = new Map<string, number>();
  const layer = Layer.effect(Push, make({ keys: generateVapidKeys(), post: (r) => Effect.sync(() => (sent.push(r), status.get(r.url) ?? 201)) })).pipe(
    Layer.provideMerge(Auth.layer),
    Layer.provideMerge(kit.layer),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(Effect.scoped(Effect.provide(effect, layer)));
  return { sent, status, run };
};

const humanKey = (name = "phone") => Effect.flatMap(Auth.Auth, (a) => a.createKey(name, [{ role: "operate", machines: "*" }], "human"));

const fileAsk = (key: string, cls: "money" | "credential" | "irreversible" | "product", text: string, blocks = "the release") =>
  Effect.flatMap(Asks, (asks) =>
    asks.create({ projectRef: REF, kind: "decide", key: key as DecisionKey, class: cls, text, recommendation: "yes", blocks, proceededOnRec: false }, LEAD.by),
  );

/** The next push.sent after `cursor`: the milestone of a push going out. */
const nextPush = (cursor: number) =>
  Effect.flatMap(EventLog.EventLog, (events) => events.wait({ cursor, types: ["push.sent"], timeoutSec: 50 })).pipe(Effect.map((page) => page.events[0] as HubEvent));
const head = Effect.flatMap(EventLog.EventLog, (events) => events.head());

/** The TestClock starts at 1970-01-01T00:00Z, inside the default quiet hours; tests about other rules turn them off. */
const quietOff = Effect.flatMap(Decisions, (decisions) =>
  decisions.record({ key: "policy.quiet_hours" as DecisionKey, scope: { kind: "global" }, value: "off" }, { source: "human", by: "human:phone" }),
);

describe("Web Push", () => {
  it("takes subscriptions from human keys only", async () => {
    const { run } = setup();
    await run(
      Effect.gen(function* () {
        const push = yield* Push;
        const agent = yield* Effect.flatMap(Auth.Auth, (a) => a.createKey("adri", [{ role: "operate", machines: "*" }]));
        const phone = device("https://push.example.com/a");
        expect(yield* Effect.flip(push.subscribe(agent.info, phone.input))).toMatchObject({ code: "forbidden" });
        expect(yield* Effect.flip(push.unsubscribe(agent.info, phone.input.endpoint))).toMatchObject({ code: "forbidden" });
        const human = (yield* humanKey()).info;
        yield* push.subscribe(human, phone.input);
        expect(yield* push.unsubscribe(human, phone.input.endpoint)).toBe(true);
        expect(yield* push.unsubscribe(human, phone.input.endpoint)).toBe(false);
      }),
    );
  });

  it("pushes a loud ask at once as one encrypted line, then holds the next for 20 minutes", async () => {
    const { run, sent } = setup();
    await run(
      Effect.gen(function* () {
        const push = yield* Push;
        yield* quietOff;
        const phone = device("https://push.example.com/a");
        yield* push.subscribe((yield* humanKey()).info, phone.input);

        // Product calls and non-blocking asks are not loud.
        yield* fileAsk("name", "product", "Call it fleetd?");
        yield* fileAsk("key", "credential", "Which key?", "nothing");
        let cursor = yield* head;
        yield* fileAsk("deploy", "irreversible", "Deploy to prod?");
        const first = yield* nextPush(cursor);
        expect(first.data).toEqual({ items: 1, devices: 1 });
        expect(sent).toHaveLength(1);
        expect(phone.open(sent[0]!)).toBe("A3 irreversible decision: Deploy to prod?");
        expect(sent[0]!.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/u);

        cursor = first.seq;
        yield* fileAsk("budget", "money", "Raise the budget to $50?");
        yield* TestClock.adjust("19 minutes");
        yield* TestClock.adjust("1 minute");
        const second = yield* nextPush(cursor);
        expect(Date.parse(second.at) - Date.parse(first.at)).toBe(20 * 60_000);
        expect(phone.open(sent[1]!)).toBe("A4 money decision: Raise the budget to $50?");
      }),
    );
  });

  it("holds all but money and irreversible items in the default quiet hours (23:00-08:00), and sends the rest when they end", async () => {
    const { run, sent } = setup();
    await run(
      Effect.gen(function* () {
        const push = yield* Push;
        const phone = device("https://push.example.com/a");
        yield* push.subscribe((yield* humanKey()).info, phone.input);
        const decisions = yield* Decisions;
        // The TestClock starts at 1970-01-01T00:00Z.
        yield* decisions.record({ key: "policy.tz" as DecisionKey, scope: { kind: "global" }, value: "UTC" }, { source: "human", by: "human:phone" });

        const cursor = yield* head;
        yield* fileAsk("token", "credential", "Need the deploy token");
        yield* fileAsk("spend", "money", "Spend $20 on CI?");
        const night = yield* nextPush(cursor);
        expect(night.at).toBe("1970-01-01T00:00:00.000Z");
        expect(sent.map(phone.open)).toEqual(["A2 money decision: Spend $20 on CI?"]);

        yield* TestClock.adjust("8 hours");
        const morning = yield* nextPush(night.seq);
        expect(morning.at).toBe("1970-01-01T08:00:00.000Z");
        expect(phone.open(sent[1]!)).toBe("A1 credential decision: Need the deploy token");
      }),
    );
  });

  it("drops subscriptions the push service calls gone and skips revoked devices", async () => {
    const { run, sent, status } = setup();
    await run(
      Effect.gen(function* () {
        const push = yield* Push;
        yield* quietOff;
        const auth = yield* Auth.Auth;
        const gone = device("https://push.example.com/gone");
        const revoked = device("https://push.example.com/revoked");
        const live = device("https://push.example.com/live");
        yield* push.subscribe((yield* humanKey("old phone")).info, gone.input);
        const tablet = yield* humanKey("tablet");
        yield* push.subscribe(tablet.info, revoked.input);
        yield* push.subscribe((yield* humanKey("phone")).info, live.input);
        yield* auth.revoke(tablet.info.keyId);
        status.set(gone.input.endpoint, 410);

        let cursor = yield* head;
        yield* fileAsk("deploy", "irreversible", "Deploy?");
        const first = yield* nextPush(cursor);
        expect(first.data).toEqual({ items: 1, devices: 1 });
        expect(sent.map((r) => r.url)).toEqual([gone.input.endpoint, live.input.endpoint]);

        // A usage breaker is loud too; by then the gone subscription is no longer tried.
        cursor = first.seq;
        yield* (yield* EventLog.EventLog).append({
          at: new Date(0).toISOString(),
          type: "usage.breaker",
          machineId: REF.machineId,
          summary: "Claude limit reached on lab-a's login",
          attention: "loud",
        });
        yield* TestClock.adjust("20 minutes");
        yield* nextPush(cursor);
        expect(sent.slice(2).map((r) => r.url)).toEqual([live.input.endpoint]);
        expect(live.open(sent[2]!)).toBe("Claude limit reached on lab-a's login");
      }),
    );
  });

  it("pushes only events the hub marked for attention", async () => {
    const { run, sent } = setup();
    await run(
      Effect.gen(function* () {
        const push = yield* Push;
        const phone = device("https://push.example.com/a");
        yield* push.subscribe((yield* humanKey()).info, phone.input);
        yield* quietOff;
        const events = yield* EventLog.EventLog;
        const offline = (machineId: string, attention?: "loud") =>
          events.append({
            at: new Date(0).toISOString(),
            type: "machine.offline",
            machineId: machineId as never,
            summary: `${machineId} went offline: no word from its node for 90 s`,
            ...(attention === undefined ? {} : { attention }),
          });
        const cursor = yield* head;
        yield* offline("lab-a");
        yield* offline("lab-b", "loud");
        yield* nextPush(cursor);
        expect(sent.map(phone.open)).toEqual(["lab-b went offline: no word from its node for 90 s"]);
      }),
    );
  });
});
