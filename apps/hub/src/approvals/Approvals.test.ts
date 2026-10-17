import { type AskId, type CheckSpec, type DecisionKey, type HubEventType, MachineId, type Machine } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { describe, expect, it } from "vitest";
import * as Auth from "../auth/Auth.ts";
import { CheckRunner } from "../checks/CheckRunner.ts";
import { type GatedOutcome, NodeCommands, type SecretOutcome, unlinked } from "../checks/NodeCommands.ts";
import { HUMAN, LEAD, makeKit, REF, reply } from "../leads/testKit.ts";
import { Asks } from "../ledger/Asks.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import { LeadWakes, type Trigger } from "../leads/LeadWakes.ts";
import { Approvals, layer as ApprovalsLayer, layerChecklists as ChecklistsLayer } from "./Approvals.ts";

const AGENT = { source: "agent" as const, by: "adri" };
const BOX_KEY = Buffer.alloc(32, 7).toString("base64");
const SEALED = Buffer.alloc(60, 9).toString("base64");

const machine: Machine = {
  machineId: MachineId.make("lab-a"),
  name: "lab-a",
  tags: [],
  status: "online",
  lastSeenAt: "1970-01-01T00:00:00.000Z",
  t3: { version: "x", protocol: 2 },
  nodeVersion: "0.0.0",
  boxPubKey: BOX_KEY,
};

/**
 * The leads kit plus approvals over a fake node and check runner whose answers each test sets. What approvals hand
 * the lead lands in `woken`, so a test waits on it instead of on the wake's debounce.
 */
const setup = () => {
  const kit = makeKit();
  const woken = Effect.runSync(Queue.unbounded<Trigger>());
  const node = {
    frames: [] as Array<{ readonly t: string; readonly input: unknown }>,
    secret: (): SecretOutcome | "offline" => ({ fingerprint: "ab12cd34" }),
    gated: (): GatedOutcome | "offline" => ({ exitCode: 0, outputTail: "deployed\n", timedOut: false }),
    verify: (): "pass" | "fail" => "pass",
  };
  const reply = <A>(machineId: MachineId, value: A | "offline") => (value === "offline" ? unlinked(machineId) : Effect.succeed(value));
  const fakes = Layer.mergeAll(
    Auth.layer,
    Layer.succeed(LeadWakes, LeadWakes.of({ trigger: (_ref, t) => Queue.offer(woken, t).pipe(Effect.asVoid), digest: () => Effect.succeed("") })),
    Layer.succeed(
      NodeCommands,
      NodeCommands.of({
        run: () => Effect.die("no cmd checks here"),
        deliverSecret: (machineId, input) => Effect.suspend(() => (node.frames.push({ t: "secret_deliver", input }), reply(machineId, node.secret()))),
        runGated: (machineId, input) => Effect.suspend(() => (node.frames.push({ t: "gated_run", input }), reply(machineId, node.gated()))),
        attach: () => Effect.void,
        resolve: () => Effect.void,
      }),
    ),
    Layer.succeed(
      CheckRunner,
      CheckRunner.of({
        run: () => Effect.die("no claims here"),
        verify: () => Effect.sync(() => (node.verify() === "pass" ? { result: "pass", evidence: "GET /health → 200" } : { result: "fail", evidence: "GET /health → 503" })),
      }),
    ),
  );
  const layer = Layer.merge(ApprovalsLayer, ChecklistsLayer).pipe(Layer.provideMerge(fakes), Layer.provideMerge(kit.layer));
  const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer>>) => Effect.runPromise(Effect.scoped(Effect.provide(effect, layer)));
  return { kit, node, run, woken };
};

/** The next event of `type` after `cursor`; the follow-ups run off the event log, so this is their milestone. */
const next = (cursor: number, type: HubEventType) =>
  Effect.flatMap(EventLog.EventLog, (events) => events.wait({ cursor, types: [type], timeoutSec: 50 })).pipe(Effect.map((page) => page.events[0]!));

const head = Effect.flatMap(EventLog.EventLog, (events) => events.head());

describe("gated runs", () => {
  it("stores the exact command, runs it only after a human's go, and wakes the lead with the result", async () => {
    const { kit, node, run, woken } = setup();
    await run(
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        const approvals = yield* Approvals;
        const asks = yield* Asks;
        const argv = ["sh", "-c", "echo deployed > /tmp/fleetd-gated-test"];
        const filed = yield* approvals.gatedRun(REF, LEAD.by, { argv, class: "irreversible", reason: "prod deploy test", timeoutSec: 1800 });
        expect(filed).toMatchObject({ op: "gated_run", state: "open" });
        const ask = (yield* asks.get(filed.askId))!;
        expect(ask).toMatchObject({
          kind: "approve",
          key: `gated.${filed.askId.toLowerCase()}`,
          class: "irreversible",
          gated: { argv, cwd: "/w/p1", class: "irreversible", reason: "prod deploy test", timeoutSec: 1800 },
          batchId: "B1",
          number: 1,
        });
        // Irreversible and blocking: published at once.
        expect((yield* asks.batches({ state: "open" }))[0]!.batchId).toBe("B1");

        // An agent may not approve it, and bulk answers pass over it.
        expect(yield* Effect.flip(reply("1 go", AGENT))).toMatchObject({ code: "forbidden", fix: expect.stringContaining("--human key") });
        expect(yield* reply("recs fine")).toMatchObject({ parsed: true, applied: [] });
        expect(yield* reply("1: sure, go ahead")).toMatchObject({ parsed: false, hint: expect.stringContaining('"1 go"') });
        expect(node.frames).toEqual([]);

        const cursor = yield* head;
        expect(yield* reply("1 go")).toMatchObject({ parsed: true, echo: expect.stringContaining("1 → go") });
        const wake = yield* Queue.take(woken);
        const evidence = "exit 0 on lab-a, approved by human:phone\ndeployed";
        expect(wake).toMatchObject({ kind: "answer", answer: { outcome: "answered", value: "go", ask: { askId: filed.askId, evidence } } });
        expect(node.frames).toEqual([{ t: "gated_run", input: { askId: filed.askId, argv, cwd: "/w/p1", timeoutSec: 1800 } }]);
        expect((yield* asks.get(filed.askId))!.evidence).toBe(evidence);
        expect((yield* next(cursor, "gated.ran")).data).toEqual({ askId: filed.askId, exitCode: 0, timedOut: false, by: HUMAN.by });
      }),
    );
  });

  it("reopens the ask when the node is offline, so nothing runs until a human approves it again", async () => {
    const { kit, node, run } = setup();
    node.gated = () => "offline";
    await run(
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        const approvals = yield* Approvals;
        const filed = yield* approvals.gatedRun(REF, LEAD.by, { argv: ["true"], class: "money", reason: "pay", timeoutSec: 60 });
        const cursor = yield* head;
        yield* reply("1 go");
        const reopened = yield* next(cursor, "ask.created");
        expect(reopened.data).toMatchObject({ askId: filed.askId, reopened: true });
        const ask = (yield* (yield* Asks).get(filed.askId))!;
        expect(ask).toMatchObject({ state: "open", batchId: "B2", evidence: expect.stringContaining("node was offline") });
        expect(ask.answer).toBeUndefined();
      }),
    );
  });

  it("refuses a command for a project the hub does not know", async () => {
    const { run } = setup();
    await run(
      Effect.gen(function* () {
        const refused = yield* Effect.flip((yield* Approvals).gatedRun(REF, LEAD.by, { argv: ["true"], class: "money", reason: "pay", timeoutSec: 60 }));
        expect(refused).toMatchObject({ code: "not_found" });
      }),
    );
  });
});

describe("secret asks", () => {
  const fileSecret = Effect.flatMap(Asks, (asks) =>
    asks.create(
      {
        projectRef: REF,
        kind: "secret",
        key: "stripe.test_key" as DecisionKey,
        class: "credential",
        text: "Need the Stripe test key",
        sink: "env:lab-a:/w/p1/.env",
        blocks: "nothing",
        proceededOnRec: false,
      },
      LEAD.by,
    ),
  );
  const keyOf = (kind: "human" | "agent") =>
    Effect.flatMap(Auth.Auth, (auth) => auth.createKey(kind === "human" ? "phone" : "adri", [{ role: "operate", machines: "*" }], kind)).pipe(Effect.map((k) => k.info));

  it("relays the sealed value to the sink's node and closes the ask with only the fingerprint", async () => {
    const { kit, node, run } = setup();
    await run(
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        yield* (yield* HubStore.HubStore).machines.upsert(machine);
        const { ask } = yield* fileSecret;
        const approvals = yield* Approvals;

        expect(yield* Effect.flip(approvals.submitSecret(yield* keyOf("agent"), { askId: ask.askId, sealed: SEALED }))).toMatchObject({
          code: "forbidden",
          fix: expect.stringContaining("--human key"),
        });
        expect(yield* reply("1: not-a-real-secret-123")).toMatchObject({ parsed: false, hint: expect.stringContaining("Never put a secret in a reply") });

        const human = yield* keyOf("human");
        node.secret = () => "offline";
        expect(yield* Effect.flip(approvals.submitSecret(human, { askId: ask.askId, sealed: SEALED }))).toMatchObject({
          code: "machine_offline",
          fix: "Try again when lab-a is online.",
        });
        node.secret = () => ({ error: "the value was not sealed to lab-a's current box key" });
        expect(yield* Effect.flip(approvals.submitSecret(human, { askId: ask.askId, sealed: SEALED }))).toMatchObject({ code: "invalid" });
        expect((yield* (yield* Asks).get(ask.askId))!.state).toBe("open");

        node.secret = () => ({ fingerprint: "ab12cd34" });
        const cursor = yield* head;
        expect(yield* approvals.submitSecret(human, { askId: ask.askId, sealed: SEALED })).toMatchObject({ askId: ask.askId, fingerprint: "ab12cd34" });
        expect(node.frames.at(-1)).toEqual({ t: "secret_deliver", input: { sink: "env:lab-a:/w/p1/.env", sealed: SEALED, secretKey: "stripe.test_key" } });
        expect(yield* (yield* Asks).get(ask.askId)).toMatchObject({
          state: "answered",
          fingerprint: "ab12cd34",
          evidence: "fingerprint ab12cd34",
          answer: { value: "saved, fingerprint ab12cd34", by: "human:phone", raw: "secret_submit" },
        });
        expect((yield* next(cursor, "ask.secret_saved")).data).toEqual({ askId: ask.askId, fingerprint: "ab12cd34", by: "human:phone" });
        // The batch it was in is done with.
        expect(yield* (yield* Asks).batches({ state: "open" })).toEqual([]);
        expect(yield* Effect.flip(approvals.submitSecret(human, { askId: ask.askId, sealed: SEALED }))).toMatchObject({ code: "invalid" });
      }),
    );
  });

  it("refuses a machine whose node publishes no box key", async () => {
    const { kit, run } = setup();
    await run(
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        const { boxPubKey: _, ...old } = machine;
        yield* (yield* HubStore.HubStore).machines.upsert(old);
        const { ask } = yield* fileSecret;
        expect(yield* Effect.flip((yield* Approvals).submitSecret(yield* keyOf("human"), { askId: ask.askId, sealed: SEALED }))).toMatchObject({
          code: "invalid",
          fix: expect.stringContaining("Update fleetd on lab-a"),
        });
      }),
    );
  });
});

describe("checklists with a verify check", () => {
  const verify: CheckSpec = { type: "http", url: "http://localhost/health", status: 200 };
  const fileDo = Effect.flatMap(Asks, (asks) =>
    asks.create(
      {
        projectRef: REF,
        kind: "do",
        key: "dns.cutover" as DecisionKey,
        class: "irreversible",
        text: "Point the DNS at the new box",
        steps: [{ text: "Change the A record", where: "browser" }],
        verify,
        blocks: "the cutover",
        proceededOnRec: false,
      },
      LEAD.by,
    ),
  );

  it("reopens a ticked checklist whose check fails, with the evidence, and passes it to the lead once it holds", async () => {
    const { kit, node, run, woken } = setup();
    node.verify = () => "fail";
    await run(
      Effect.gen(function* () {
        yield* kit.addProject(REF);
        const { ask } = yield* fileDo;
        expect(yield* Effect.flip(reply("1 done", AGENT))).toMatchObject({ code: "forbidden" });

        const cursor = yield* head;
        yield* reply("1 done");
        expect((yield* next(cursor, "ask.created")).data).toMatchObject({ askId: ask.askId, reopened: true });
        const reopened = (yield* (yield* Asks).get(ask.askId))!;
        expect(reopened).toMatchObject({ state: "open", batchId: "B2", evidence: "ticked done, but its check failed: GET /health → 503" });
        // Its first decision no longer stands, and the lead has heard nothing.
        expect(reopened.decisionId).toBeUndefined();
        expect(yield* Queue.size(woken)).toBe(0);

        node.verify = () => "pass";
        yield* reply("#B2 1 done");
        const wake = yield* Queue.take(woken);
        expect(wake).toMatchObject({ kind: "answer", answer: { value: "done", ask: { askId: ask.askId, evidence: "verified: GET /health → 200" } } });
        expect((yield* (yield* Asks).get(ask.askId))!).toMatchObject({ state: "answered", evidence: "verified: GET /health → 200" });
      }),
    );
  });

  it("refuses verify on other kinds and checks fleetd cannot run itself", async () => {
    const { run } = setup();
    await run(
      Effect.gen(function* () {
        const asks = yield* Asks;
        const base = { projectRef: REF, key: "x.y" as DecisionKey, class: "product", text: "?", blocks: "nothing", proceededOnRec: false } as const;
        expect(yield* Effect.flip(asks.create({ ...base, kind: "decide", recommendation: "a", verify }, LEAD.by))).toMatchObject({ code: "invalid" });
        const steps = [{ text: "s", where: "browser" as const }];
        expect(yield* Effect.flip(asks.create({ ...base, kind: "do", steps, verify: { type: "judge", criteria: "looks right" } }, LEAD.by))).toMatchObject({ code: "invalid" });
        expect(
          yield* Effect.flip(asks.create({ ...base, kind: "secret", key: "1password.token" as DecisionKey, class: "credential", sink: "env:lab-a:/w/p1/.env" }, LEAD.by)),
        ).toMatchObject({ code: "invalid", fix: expect.stringContaining("--env-name") });
        expect((yield* asks.list({})).map((a) => a.askId as AskId)).toEqual([]);
      }),
    );
  });
});
