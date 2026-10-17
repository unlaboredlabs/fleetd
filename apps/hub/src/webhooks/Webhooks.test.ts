import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MachineId, type AgentKeyInfo, type Grant, type HubEvent } from "@fleetd/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";
import * as Auth from "../auth/Auth.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as SecretBox from "./SecretBox.ts";
import * as Signing from "./Signing.ts";
import * as Webhooks from "./Webhooks.ts";

describe("Standard Webhooks signing", () => {
  // The published test vector used by every standard-webhooks reference library (e.g. libraries/go/webhook_test.go).
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const id = "msg_p5jXN8AQM9LWM0D4loKWxJek";
  const timestamp = 1614265330;
  const body = '{"test": 2432232314}';
  const expected = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";

  it("matches the spec's published signature", () => {
    expect(Signing.sign(secret, id, timestamp, body)).toBe(expected);
    expect(Signing.sign(secret.slice("whsec_".length), id, timestamp, body)).toBe(expected);
  });

  it("verifies any of several signatures, and rejects a changed body or a stale timestamp", () => {
    const headers = { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": `v1,bm9wZQ== ${expected}` };
    expect(Signing.verify(secret, headers, body, timestamp + 10)).toBe(true);
    expect(Signing.verify(secret, headers, '{"test": 2432232315}', timestamp)).toBe(false);
    expect(Signing.verify(secret, headers, body, timestamp + 301)).toBe(false);
  });

  it("makes whsec_ secrets of 32 random bytes", () => {
    const made = Signing.newSecret();
    expect(made).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/u);
    expect(Buffer.from(made.slice(6), "base64")).toHaveLength(32);
  });
});

const dirs: Array<string> = [];
const tempHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-webhooks-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("SecretBox", () => {
  it("creates a 0600 key file once and opens only what it sealed", () => {
    const file = path.join(tempHome(), "webhook.key");
    const box = SecretBox.fromKeyFile(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const sealed = box.seal("whsec_abc");
    expect(sealed).not.toContain("whsec_abc");
    expect(SecretBox.fromKeyFile(file).open(sealed)).toBe("whsec_abc");
    expect(() => SecretBox.fromKey(crypto.randomBytes(32)).open(sealed)).toThrow();
  });
});

const m = (id: string) => MachineId.make(id);
const event = (type: HubEvent["type"], machine?: string): Omit<HubEvent, "seq"> => ({
  at: "2026-10-17T10:00:00.000Z",
  type,
  ...(machine === undefined ? {} : { machineId: m(machine) }),
  summary: `${type}${machine === undefined ? "" : ` on ${machine}`}`,
});

interface Attempt {
  readonly atSec: number;
  readonly seq: number;
  readonly request: Webhooks.WebhookRequest;
}

/** A receiver that answers each attempt with the next scripted status (then 200), recording when it was called. */
const receiver = (script: Array<number | "refused"> = []) => {
  const attempts: Array<Attempt> = [];
  const post: Webhooks.Post = (request) =>
    Effect.gen(function* () {
      const atSec = (yield* Clock.currentTimeMillis) / 1000;
      attempts.push({ atSec, seq: (JSON.parse(request.body) as HubEvent).seq, request });
      const next = script.shift() ?? 200;
      return next === "refused" ? yield* Effect.fail("ECONNREFUSED") : next;
    });
  return { attempts, post };
};

const services = (post: Webhooks.Post, db: Layer.Layer<HubDb.HubDb>, box: SecretBox.SecretBox) =>
  Layer.effect(Webhooks.Webhooks, Webhooks.make({ box, post })).pipe(
    Layer.provideMerge(Layer.mergeAll(EventLog.layer, Auth.layer)),
    Layer.provideMerge(db),
  );

type Services = Webhooks.Webhooks | EventLog.EventLog | Auth.Auth | HubDb.HubDb;

const run = <A>(
  post: Webhooks.Post,
  effect: Effect.Effect<A, never, Services>,
  db: Layer.Layer<HubDb.HubDb> = HubDb.layerMemory,
  box = SecretBox.fromKey(crypto.randomBytes(32)),
) => Effect.runPromise(effect.pipe(Effect.provide(services(post, db, box).pipe(Layer.provideMerge(TestClock.layer())))));

const key = (name: string, grants: ReadonlyArray<Grant>) =>
  Effect.flatMap(Auth.Auth, (auth) => Effect.map(auth.createKey(name, grants), (k) => k.info));
const append = (...events: ReadonlyArray<Omit<HubEvent, "seq">>) => Effect.flatMap(EventLog.EventLog, (log) => Effect.forEach(events, log.append));
const subscribe = (caller: AgentKeyInfo, input: Partial<Webhooks.CreateInput> = {}) =>
  Effect.flatMap(Webhooks.Webhooks, (w) =>
    w.create(caller, { url: "https://example.test/hook?token=t", types: "*", machines: "*", clientRequestId: "r1", ...input }),
  );
const list = (caller: AgentKeyInfo) => Effect.flatMap(Webhooks.Webhooks, (w) => w.list(caller));
const logged = (types: ReadonlyArray<HubEvent["type"]>) =>
  Effect.flatMap(EventLog.EventLog, (log) => Effect.map(log.wait({ cursor: 0, types, timeoutSec: 0 }), (page) => page.events));

describe("webhook delivery", () => {
  it("retries one event at 1 s, 5 s, 30 s, 2 min, 10 min, then hourly, holding later events back until it succeeds", async () => {
    const { attempts, post } = receiver([500, "refused", 500, 503, 500, 500]);
    await run(
      post,
      Effect.gen(function* () {
        const admin = yield* key("admin", [{ role: "admin", machines: "*" }]);
        yield* append(event("thread.completed", "lab-a")); // before the subscription: never delivered
        const { secret } = yield* subscribe(admin, { types: ["thread.completed"], machines: [m("lab-a")] });
        const [, , first, second] = yield* append(
          event("thread.started", "lab-a"),
          event("thread.completed", "lab-b"),
          event("thread.completed", "lab-a"),
          event("thread.completed", "lab-a"),
        );
        yield* TestClock.adjust("0 seconds");
        expect(attempts.map((a) => [a.atSec, a.seq])).toEqual([[0, first!.seq]]);

        yield* TestClock.adjust("13 minutes"); // through the 10 min retry at 756 s
        expect(attempts.map((a) => a.atSec)).toEqual([0, 1, 6, 36, 156, 756]);
        expect(attempts.every((a) => a.seq === first!.seq)).toBe(true);
        const [failing] = yield* list(admin);
        expect(failing).toMatchObject({ failingSince: new Date(0).toISOString(), lastDeliveredSeq: first!.seq - 1 });

        // webhook.failing fires once, an hour into the failing spell, between the hourly retries.
        yield* TestClock.adjust("46 minutes");
        expect(yield* logged(["webhook.failing"])).toEqual([]);
        yield* TestClock.adjust("1 minute");
        const reported = yield* logged(["webhook.failing"]);
        expect(reported).toHaveLength(1);
        expect(reported[0]!.at).toBe(new Date(3600_000).toISOString());
        expect(reported[0]!.summary).toContain("https://example.test");
        expect(reported[0]!.summary).not.toContain("token");

        yield* TestClock.adjust("1 hour");
        expect(attempts.map((a) => [a.atSec, a.seq])).toEqual([
          ...[0, 1, 6, 36, 156, 756].map((s) => [s, first!.seq]),
          [756 + 3600, first!.seq],
          [756 + 3600, second!.seq],
        ]);
        expect(yield* logged(["webhook.failing"])).toHaveLength(1);
        const [healthy] = yield* list(admin);
        // The cursor also moves past the webhook.failing event the type filter skips.
        expect(healthy).toMatchObject({ lastDeliveredSeq: reported[0]!.seq });
        expect(healthy).not.toHaveProperty("failingSince");

        // Each attempt is signed afresh with its own timestamp; the id stays the same across retries.
        for (const { request, atSec } of attempts) {
          expect(request.headers["webhook-timestamp"]).toBe(String(atSec));
          expect(Signing.verify(secret, request.headers as unknown as Signing.SignedHeaders, request.body, atSec)).toBe(true);
        }
        expect(new Set(attempts.slice(0, 7).map((a) => a.request.headers["webhook-id"])).size).toBe(1);
      }),
    );
  });

  it("delivers only what the creator's key may read, and lists only the caller's own subscriptions", async () => {
    const { attempts, post } = receiver();
    await run(
      post,
      Effect.gen(function* () {
        const admin = yield* key("admin", [{ role: "admin", machines: "*" }]);
        const aOnly = yield* key("a", [{ role: "operate", machines: [m("lab-a")] }]);
        const sub = yield* subscribe(aOnly);
        expect(yield* subscribe(aOnly)).toEqual(sub); // same clientRequestId, same subscription and secret
        const [, onA] = yield* append(event("thread.completed", "lab-b"), event("thread.completed", "lab-a"));
        yield* TestClock.adjust("0 seconds");
        expect(attempts.map((a) => a.seq)).toEqual([onA!.seq]);

        const other = yield* subscribe(admin, { clientRequestId: "r2" });
        expect((yield* list(aOnly)).map((s) => s.subscriptionId)).toEqual([sub.subscriptionId]);
        expect((yield* list(admin)).map((s) => s.subscriptionId).toSorted()).toEqual([sub.subscriptionId, other.subscriptionId].toSorted());
        expect(JSON.stringify(yield* list(admin))).not.toContain(sub.secret.slice(6));
        const webhooks = yield* Webhooks.Webhooks;
        expect(yield* webhooks.remove(aOnly, other.subscriptionId)).toBe(false);
        expect(yield* webhooks.remove(aOnly, sub.subscriptionId)).toBe(true);
        const [later] = yield* append(event("thread.completed", "lab-a"));
        yield* TestClock.adjust("0 seconds");
        // Only the admin's subscription is left to deliver it.
        expect(attempts.map((a) => a.seq)).toEqual([onA!.seq, later!.seq]);
        expect(attempts[1]!.request.headers["webhook-id"]).toContain(other.subscriptionId);
      }),
    );
  });

  it("stores the secret sealed and resumes from its cursor after a restart", async () => {
    const home = tempHome();
    const box = () => SecretBox.fromKeyFile(path.join(home, "webhook.key"));
    const first = receiver();
    const { secret } = await run(
      first.post,
      Effect.gen(function* () {
        const admin = yield* key("admin", [{ role: "admin", machines: "*" }]);
        const created = yield* subscribe(admin);
        yield* append(event("machine.online", "lab-a"));
        yield* TestClock.adjust("0 seconds");
        const { db } = yield* HubDb.HubDb;
        expect(JSON.stringify(db.prepare("SELECT * FROM subscriptions").all())).not.toContain(created.secret.slice(6));
        return created;
      }),
      HubDb.layer(home),
      box(),
    );
    expect(first.attempts.map((a) => a.seq)).toEqual([1]);

    const second = receiver();
    await run(
      second.post,
      Effect.gen(function* () {
        yield* append(event("machine.offline", "lab-a"));
        yield* TestClock.adjust("0 seconds");
      }),
      HubDb.layer(home),
      box(),
    );
    expect(second.attempts.map((a) => a.seq)).toEqual([2]);
    const { request } = second.attempts[0]!;
    expect(Signing.verify(secret, request.headers as unknown as Signing.SignedHeaders, request.body, 0)).toBe(true);
  });
});
