import crypto from "node:crypto";
import { AgentKeyPrefix, MachineId, type AgentKeyInfo, type Grant } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import * as HubDb from "../store/HubDb.ts";
import * as Auth from "./Auth.ts";

const run = <A, E>(effect: Effect.Effect<A, E, Auth.Auth | HubDb.HubDb>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Auth.layer.pipe(Layer.provideMerge(HubDb.layerMemory), Layer.provideMerge(TestClock.layer()))),
    ),
  );

const m = (id: string) => MachineId.make(id);
const operateAll: ReadonlyArray<Grant> = [{ role: "operate", machines: "*" }];

const failure = <A, E>(effect: Effect.Effect<A, E, Auth.Auth>) => Effect.flip(effect);

describe("agent keys", () => {
  it("creates fld_ keys in lowercase base32 and stores only their sha256", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* Auth.Auth;
        const { db } = yield* HubDb.HubDb;
        const { key, info } = yield* auth.createKey("ci", operateAll);
        expect(key).toMatch(/^fld_[a-z2-7]{52}$/u);
        expect(info.prefix).toBe(key.slice(0, 10));
        expect(Schema.is(AgentKeyPrefix)(info.prefix)).toBe(true);
        const stored = db.prepare("SELECT * FROM agent_keys").all();
        expect(JSON.stringify(stored)).not.toContain(key.slice(4));
        expect(stored[0]?.hash).toBe(crypto.createHash("sha256").update(key).digest("hex"));
        expect(yield* auth.list()).toEqual([info]);
      }),
    ));

  it("verifies a key with or without the Bearer scheme and rejects others", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* Auth.Auth;
        const { key, info } = yield* auth.createKey("ci", operateAll);
        expect((yield* auth.verify(key)).keyId).toBe(info.keyId);
        expect((yield* auth.verify(`Bearer ${key}`)).keyId).toBe(info.keyId);
        const other = `fld_${"a".repeat(52)}`;
        expect(yield* failure(auth.verify(other))).toMatchObject({ code: "forbidden", message: "unknown agent key" });
        expect(yield* failure(auth.verify("Bearer nope"))).toMatchObject({ code: "invalid" });
      }),
    ));

  it("revokes immediately and idempotently", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* Auth.Auth;
        const { key, info } = yield* auth.createKey("ci", operateAll);
        const verified = yield* auth.verify(key);
        yield* auth.revoke(info.keyId);
        const error = yield* failure(auth.verify(key));
        expect(error).toMatchObject({ code: "forbidden", message: `agent key ${info.prefix} was revoked` });
        expect(error.fix).toContain("fleetd hub key create");

        yield* TestClock.adjust("1 hour");
        yield* auth.revoke(info.keyId);
        const [listed] = yield* auth.list();
        expect(listed?.revokedAt).toBe(new Date(0).toISOString());
        expect(auth.allows(verified, "read")).toBe(true);
        expect(listed && auth.allows(listed, "read")).toBe(false);

        expect(yield* failure(auth.revoke("key_missing"))).toMatchObject({ _tag: "KeyNotFound", keyId: "key_missing" });
      }),
    ));

  it("writes lastUsedAt at most once a minute", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* Auth.Auth;
        const { key, info } = yield* auth.createKey("ci", operateAll);
        expect(info.lastUsedAt).toBeUndefined();
        const lastUsed = () => Effect.map(auth.list(), ([k]) => k?.lastUsedAt);

        expect((yield* auth.verify(key)).lastUsedAt).toBe(new Date(0).toISOString());
        yield* TestClock.adjust("59 seconds");
        yield* auth.verify(key);
        expect(yield* lastUsed()).toBe(new Date(0).toISOString());
        yield* TestClock.adjust("1 second");
        yield* auth.verify(key);
        expect(yield* lastUsed()).toBe(new Date(60_000).toISOString());
      }),
    ));
});

describe("grants", () => {
  const info = (grants: ReadonlyArray<Grant>): AgentKeyInfo => ({
    keyId: "key_x",
    name: "x",
    prefix: "fld_abcdef",
    grants,
    createdAt: new Date(0).toISOString(),
  });

  it("ranks read < operate < admin and scopes by machine", () =>
    run(
      Effect.gen(function* () {
        const { allows } = yield* Auth.Auth;
        const key = info([
          { role: "operate", machines: [m("lab-a")] },
          { role: "read", machines: "*" },
        ]);
        expect(allows(key, "operate", m("lab-a"))).toBe(true);
        expect(allows(key, "read", m("lab-a"))).toBe(true);
        expect(allows(key, "admin", m("lab-a"))).toBe(false);
        expect(allows(key, "operate", m("lab-b"))).toBe(false);
        expect(allows(key, "read", m("lab-b"))).toBe(true);
        // Fleet-wide calls need the role on some machine; results are filtered per machine afterwards.
        expect(allows(key, "operate")).toBe(true);
        expect(allows(key, "admin")).toBe(false);
        expect(allows(info([]), "read")).toBe(false);
        expect(allows(info([{ role: "admin", machines: [] }]), "read", m("lab-a"))).toBe(false);
      }),
    ));
});

describe("enrollment tokens", () => {
  it("are one-time and record the node key", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* Auth.Auth;
        const { token, expiresAt } = yield* auth.createEnrollToken(m("lab-a"));
        expect(expiresAt).toBe(new Date(15 * 60_000).toISOString());
        expect(yield* auth.nodePubKey(m("lab-a"))).toBeUndefined();
        yield* auth.consumeEnrollToken(token, m("lab-a"), "pub-1");
        expect(yield* auth.nodePubKey(m("lab-a"))).toBe("pub-1");
        const again = yield* failure(auth.consumeEnrollToken(token, m("lab-a"), "pub-2"));
        expect(again).toMatchObject({ code: "forbidden", message: "enrollment token was already used" });
        expect(again.fix).toContain("fleetd hub token create --machine lab-a");
        expect(yield* auth.nodePubKey(m("lab-a"))).toBe("pub-1");
      }),
    ));

  it("expire after 15 minutes", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* Auth.Auth;
        const early = yield* auth.createEnrollToken(m("lab-a"));
        const late = yield* auth.createEnrollToken(m("lab-b"));
        yield* TestClock.adjust("14 minutes");
        yield* auth.consumeEnrollToken(early.token, m("lab-a"), "pub-a");
        yield* TestClock.adjust("1 minute");
        expect(yield* failure(auth.consumeEnrollToken(late.token, m("lab-b"), "pub-b"))).toMatchObject({
          message: "enrollment token expired",
        });
        expect(yield* auth.nodePubKey(m("lab-b"))).toBeUndefined();
      }),
    ));

  it("only enroll the machine they were made for, and survive a wrong-machine attempt", () =>
    run(
      Effect.gen(function* () {
        const auth = yield* Auth.Auth;
        const { token } = yield* auth.createEnrollToken(m("lab-a"));
        expect(yield* failure(auth.consumeEnrollToken(token, m("lab-b"), "pub"))).toMatchObject({
          message: "enrollment token is for machine lab-a, not lab-b",
        });
        expect(yield* failure(auth.consumeEnrollToken("fle_bogus", m("lab-a"), "pub"))).toMatchObject({
          message: "unknown enrollment token",
        });
        yield* auth.consumeEnrollToken(token, m("lab-a"), "pub");
        expect(yield* auth.nodePubKey(m("lab-a"))).toBe("pub");
      }),
    ));
});
