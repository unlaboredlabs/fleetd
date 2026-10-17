import { Buffer } from "node:buffer";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  Ask,
  BoxPublicKey,
  LeadCall,
  NodeToHub,
  PushSubscribeInput,
  SECRET_MAX_BYTES,
  SealedSecret,
  SecretSink,
  base64Bytes,
  parseSecretSink,
  secretEnvName,
} from "./index.ts";

const accepts = (schema: Schema.Top, value: unknown) => Schema.decodeUnknownResult(schema as Schema.Codec<unknown>)(value)._tag === "Success";
const b64 = (bytes: number) => Buffer.alloc(bytes, 0xa7).toString("base64");
const at = "2026-10-17T10:00:00.000Z";

describe("base64Bytes", () => {
  it("counts bytes of canonical base64 only", () => {
    for (const n of [0, 1, 2, 3, 32, 65]) {
      expect(base64Bytes(b64(n), "base64"), `${n}`).toBe(n);
      expect(base64Bytes(Buffer.alloc(n, 0xfb).toString("base64url"), "base64url"), `url ${n}`).toBe(n);
    }
    // Padded base64url is accepted; standard base64 must be padded.
    expect(base64Bytes("qw==", "base64url")).toBe(1);
    for (const bad of ["qw", "q", "qw=", "q===", "qx==", "a-b_", "a b=", "qw==qw=="]) {
      expect(base64Bytes(bad, "base64"), bad).toBeUndefined();
    }
    expect(base64Bytes("+/8=", "base64url")).toBeUndefined();
  });
});

describe("BoxPublicKey and SealedSecret", () => {
  it("takes exactly 32 bytes for a box key", () => {
    expect(accepts(BoxPublicKey, b64(32))).toBe(true);
    for (const key of [b64(31), b64(33), Buffer.alloc(32, 0xfb).toString("base64url"), ""]) expect(accepts(BoxPublicKey, key), key).toBe(false);
  });

  it("bounds a sealed box by the seal overhead and the plaintext limit", () => {
    expect(accepts(SealedSecret, b64(48))).toBe(false);
    expect(accepts(SealedSecret, b64(49))).toBe(true);
    expect(accepts(SealedSecret, b64(48 + SECRET_MAX_BYTES))).toBe(true);
    expect(accepts(SealedSecret, b64(49 + SECRET_MAX_BYTES))).toBe(false);
  });
});

describe("SecretSink", () => {
  it("splits env and file sinks", () => {
    expect(parseSecretSink("env:forge:/home/wynn/app/.env")).toEqual({ kind: "env", machineId: "forge", path: "/home/wynn/app/.env" });
    expect(parseSecretSink("file:lab-a:/srv/keys/stripe")).toEqual({ kind: "file", machineId: "lab-a", path: "/srv/keys/stripe" });
  });

  it("refuses relative, traversing and malformed paths", () => {
    for (const sink of [
      "env:forge:relative/.env",
      "env:forge:",
      "env:forge:/",
      "env:forge:/a/../etc/passwd",
      "env:forge:/a/./b",
      "env:forge:/a//b",
      "env:forge:/a/",
      "env:forge:/a\nb",
      "ghSecret:forge:/a",
      "env:Forge:/a",
      "env:/a",
      `file:forge:/${"a".repeat(1000)}`,
    ]) {
      expect(accepts(SecretSink, sink), JSON.stringify(sink)).toBe(false);
    }
  });
});

const ask = {
  askId: "A1",
  projectRef: { machineId: "forge", projectId: "p1" },
  key: "stripe.test_key",
  class: "credential",
  text: "Need the Stripe test key",
  blocks: "nothing",
  proceededOnRec: false,
  state: "open",
  createdAt: at,
};
const gated = { argv: ["sh", "-c", "echo deployed"], class: "irreversible", reason: "prod deploy test", timeoutSec: 1800 };

describe("secretEnvName", () => {
  it("uppercases the key and turns . and - into _", () => {
    expect(secretEnvName("stripe.test_key")).toBe("STRIPE_TEST_KEY");
    expect(secretEnvName("gh.deploy-token")).toBe("GH_DEPLOY_TOKEN");
    expect(secretEnvName("1password.token")).toBeUndefined();
  });

  it("lets only a secret ask with an env: sink carry an env name", () => {
    const base = { op: "ask", key: "stripe.test_key", class: "credential", text: "Need the key", kind: "secret" };
    expect(accepts(LeadCall, { ...base, sink: "env:forge:/srv/app/.env", envName: "STRIPE_KEY" })).toBe(true);
    expect(accepts(LeadCall, { ...base, sink: "file:forge:/srv/app/key", envName: "STRIPE_KEY" })).toBe(false);
    expect(accepts(LeadCall, { ...base, sink: "env:forge:/srv/app/.env", envName: "1BAD" })).toBe(false);
  });
});

describe("Ask kinds", () => {
  it("needs each kind's field and refuses another kind's", () => {
    expect(accepts(Ask, { ...ask, kind: "secret", sink: "env:forge:/srv/app/.env", fingerprint: "ab12cd34" })).toBe(true);
    expect(accepts(Ask, { ...ask, kind: "secret" })).toBe(false);
    expect(accepts(Ask, { ...ask, kind: "secret", sink: "env:forge:/srv/app/.env", fingerprint: "AB12CD34" })).toBe(false);
    expect(accepts(Ask, { ...ask, kind: "decide", recommendation: "x", sink: "env:forge:/srv/app/.env" })).toBe(false);
    expect(accepts(Ask, { ...ask, kind: "decide", recommendation: "x", fingerprint: "ab12cd34" })).toBe(false);

    expect(accepts(Ask, { ...ask, kind: "approve", class: "irreversible", gated })).toBe(true);
    expect(accepts(Ask, { ...ask, kind: "approve", class: "irreversible" })).toBe(false);
    expect(accepts(Ask, { ...ask, kind: "approve", class: "money", gated })).toBe(false);
    expect(accepts(Ask, { ...ask, kind: "do", steps: [{ text: "s", where: "phone" }], gated })).toBe(false);

    const verify = { type: "http", url: "https://example.com/health", status: 200 };
    expect(accepts(Ask, { ...ask, kind: "do", steps: [{ text: "s", where: "phone" }], verify })).toBe(true);
    expect(accepts(Ask, { ...ask, kind: "decide", recommendation: "x", verify })).toBe(false);
  });
});

describe("secret and gated lead calls", () => {
  const decode = Schema.decodeUnknownSync(LeadCall);

  it("needs a sink for a secret ask and refuses approve asks outside gated run", () => {
    const base = { op: "ask", key: "stripe.test_key", class: "credential", text: "Need the key" };
    expect(accepts(LeadCall, { ...base, kind: "secret", sink: "env:forge:/srv/app/.env" })).toBe(true);
    expect(accepts(LeadCall, { ...base, kind: "secret" })).toBe(false);
    expect(accepts(LeadCall, { ...base, kind: "approve" })).toBe(false);
  });

  it("defaults the gated timeout to 30 minutes and refuses anything looser", () => {
    const call = { op: "gated_run", argv: gated.argv, class: "irreversible", reason: "prod deploy test" };
    expect(decode(call)).toMatchObject({ timeoutSec: 1800 });
    expect(accepts(LeadCall, { ...call, timeoutSec: 1801 })).toBe(false);
    expect(accepts(LeadCall, { ...call, argv: [] })).toBe(false);
    expect(accepts(LeadCall, { ...call, class: "product" })).toBe(false);
    expect(accepts(LeadCall, { ...call, cwd: "srv/app" })).toBe(false);
    expect(accepts(LeadCall, { ...call, secretEnv: [{ name: "STRIPE_KEY", secretKey: "stripe.test_key" }] })).toBe(true);
    expect(accepts(LeadCall, { ...call, secretEnv: [{ name: "1BAD", secretKey: "stripe.test_key" }] })).toBe(false);
    const twice = [
      { name: "K", secretKey: "a.one" },
      { name: "K", secretKey: "a.two" },
    ];
    expect(accepts(LeadCall, { ...call, secretEnv: twice })).toBe(false);
  });
});

describe("node link M8 frames", () => {
  it("carries exactly one of fingerprint and error in a secret result", () => {
    expect(accepts(NodeToHub, { t: "secret_result", id: "s1", fingerprint: "ab12cd34" })).toBe(true);
    expect(accepts(NodeToHub, { t: "secret_result", id: "s1", error: "sink outside the command roots" })).toBe(true);
    expect(accepts(NodeToHub, { t: "secret_result", id: "s1" })).toBe(false);
    expect(accepts(NodeToHub, { t: "secret_result", id: "s1", fingerprint: "ab12cd34", error: "x" })).toBe(false);
  });

  it("validates the hello's box key when present", () => {
    const hello = { t: "hello", machineId: "forge", name: "forge", tags: [], nodeVersion: "0.0.0", protocol: 1, pubKey: "k", sig: "s" };
    expect(accepts(NodeToHub, hello)).toBe(true);
    expect(accepts(NodeToHub, { ...hello, boxPubKey: b64(32) })).toBe(true);
    expect(accepts(NodeToHub, { ...hello, boxPubKey: b64(16) })).toBe(false);
  });
});

describe("push_subscribe", () => {
  const input = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    keys: { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: Buffer.alloc(16, 9).toString("base64url") },
    deviceName: "phone",
  };

  it("takes a browser subscription and a loopback lab endpoint", () => {
    expect(accepts(PushSubscribeInput, input)).toBe(true);
    expect(accepts(PushSubscribeInput, { ...input, endpoint: "http://127.0.0.1:4790/push" })).toBe(true);
  });

  it("refuses plain http off loopback and wrong key sizes", () => {
    expect(accepts(PushSubscribeInput, { ...input, endpoint: "http://push.example.com/x" })).toBe(false);
    expect(accepts(PushSubscribeInput, { ...input, keys: { ...input.keys, p256dh: Buffer.alloc(64, 4).toString("base64url") } })).toBe(false);
    expect(accepts(PushSubscribeInput, { ...input, keys: { ...input.keys, auth: Buffer.alloc(15, 9).toString("base64url") } })).toBe(false);
  });
});
