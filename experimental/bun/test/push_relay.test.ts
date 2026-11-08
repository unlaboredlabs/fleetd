// The push relay against fake APNs and FCM servers on this machine (keys made here): what it sends each, and how it
// answers a hub for what they say (crates/fleetd/src/push_relay/tests.rs's cases).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { Apns, Fcm, Relay, router, TOKEN_MAX } from "../src/push_relay/index.ts";

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const p8 = ec.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

type Seen = { path: string; headers: Record<string, string>; body: string };
const seen: Seen[] = [];
let apnsAnswer: { status: number; reason?: string } = { status: 200 };
let fcmAnswer: { status: number; body?: unknown } = { status: 200 };

const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    seen.push({ path: url.pathname, headers: Object.fromEntries(req.headers), body: await req.text() });
    if (url.pathname.startsWith("/3/device/")) {
      return apnsAnswer.reason === undefined
        ? new Response(null, { status: apnsAnswer.status })
        : Response.json({ reason: apnsAnswer.reason }, { status: apnsAnswer.status });
    }
    if (url.pathname === "/token") return Response.json({ access_token: "ya29.test", expires_in: 3600 });
    return Response.json(fcmAnswer.body ?? {}, { status: fcmAnswer.status });
  },
});
const base = `http://127.0.0.1:${upstream.port}`;
const account = JSON.stringify({
  project_id: "fleetd-test",
  client_email: "relay@fleetd-test.iam.example",
  private_key: rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  token_uri: `${base}/token`,
});

let relay: Relay;
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  relay = new Relay(Apns.create(p8, "KEY123", "TEAM456", "sh.fleetd.app", base), Fcm.create(account, base));
  const route = router(relay);
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req, s) => route(req, s) });
});
afterAll(() => {
  server.stop(true);
  upstream.stop(true);
});

const at = () => `http://127.0.0.1:${server.port}`;
const push = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${at()}/v1/push`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const ios = (token = "a1b2c3", extra: object = {}) => ({ platform: "ios", token, ciphertext: "c2VhbGVk", ...extra });

describe("the push relay", () => {
  test("its health says which it sends", async () => {
    expect(await (await fetch(`${at()}/`)).json()).toEqual({ ok: true, apns: true, fcm: true });
  });

  test("an iOS push goes to APNs as an alert the app decrypts, with a JWT the .p8 key signed", async () => {
    seen.length = 0;
    apnsAnswer = { status: 200 };
    const res = await push(ios("a1b2c3", { collapseKey: "W41" }));
    expect([res.status, await res.json()]).toEqual([200, { status: "sent" }]);
    const sent = seen[0]!;
    expect(sent.path).toBe("/3/device/a1b2c3");
    expect(sent.headers["apns-topic"]).toBe("sh.fleetd.app");
    expect(sent.headers["apns-push-type"]).toBe("alert");
    expect(sent.headers["apns-collapse-id"]).toBe("W41");
    expect(JSON.parse(sent.body)).toEqual({
      aps: { alert: { title: "fleetd", body: "New activity" }, "mutable-content": 1, sound: "default" },
      c: "c2VhbGVk",
    });
    const [head, claims, sig] = sent.headers.authorization!.slice(7).split(".");
    expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString()).iss).toBe("TEAM456");
    const ok = verify("sha256", Buffer.from(`${head}.${claims}`), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"));
    expect(ok).toBe(true);
  });

  test("410 is a dead token; BadDeviceToken is one only once a push has gone through", async () => {
    apnsAnswer = { status: 410, reason: "Unregistered" };
    expect(await (await push(ios("dead01"))).json()).toEqual({ status: "dead" });
    const fresh = new Relay(Apns.create(p8, "KEY123", "TEAM456", "sh.fleetd.app", base), undefined);
    const route = router(fresh);
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req, srv) => route(req, srv) });
    try {
      apnsAnswer = { status: 400, reason: "BadDeviceToken" };
      const res = await fetch(`http://127.0.0.1:${s.port}/v1/push`, { method: "POST", body: JSON.stringify(ios("bad01")) });
      const body: any = await res.json();
      expect(res.status).toBe(502);
      expect(body.error).toContain("APNs answered BadDeviceToken and no push has gone through yet: the relay sends to production");
    } finally {
      s.stop(true);
    }
    // This relay has sent one: the same answer now means the token is gone.
    expect(await (await push(ios("bad02"))).json()).toEqual({ status: "dead" });
  });

  test("an Android push goes to FCM v1 with an access token from the service account; UNREGISTERED is dead", async () => {
    seen.length = 0;
    fcmAnswer = { status: 200 };
    const res = await push({ platform: "android", token: "fcm:tok-1", ciphertext: "c2VhbGVk", collapseKey: "W41" });
    expect(await res.json()).toEqual({ status: "sent" });
    const token = seen.find((s) => s.path === "/token")!;
    expect(new URLSearchParams(token.body).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const sent = seen.find((s) => s.path === "/v1/projects/fleetd-test/messages:send")!;
    expect(sent.headers.authorization).toBe("Bearer ya29.test");
    expect(JSON.parse(sent.body)).toEqual({
      message: { token: "fcm:tok-1", data: { c: "c2VhbGVk" }, android: { priority: "high", collapse_key: "W41" } },
    });
    fcmAnswer = { status: 404, body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } };
    expect(await (await push({ platform: "android", token: "fcm:tok-2", ciphertext: "eA==" })).json()).toEqual({ status: "dead" });
    fcmAnswer = { status: 403, body: { error: { status: "PERMISSION_DENIED" } } };
    const refused: any = await (await push({ platform: "android", token: "fcm:tok-3", ciphertext: "eA==" })).json();
    expect(refused.error).toBe(
      "FCM refused the service account (403 PERMISSION_DENIED): it must be from project fleetd-test, with the Firebase Cloud Messaging API on and a role that may send",
    );
  });

  test("what isn't a push is refused before anything is sent", async () => {
    seen.length = 0;
    const answers = await Promise.all([
      push({ platform: "ios", token: "has/slash", ciphertext: "eA==" }),
      push({ platform: "windows", token: "a", ciphertext: "eA==" }),
      push(ios("a1", { ciphertext: "x".repeat(3501) })),
      push(ios("x".repeat(TOKEN_MAX + 1))),
      push(ios("a1", { collapseKey: "not ok" })),
    ]);
    expect(answers.map((a) => a.status)).toEqual([400, 400, 413, 400, 400]);
    expect(await answers[2]!.json()).toEqual({ status: "failed", error: "ciphertext too long" });
    expect(seen).toEqual([]);
  });

  test("one device gets at most 60 pushes a minute", async () => {
    apnsAnswer = { status: 200 };
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await push(ios("ratelimited"))).status;
    expect(last).toBe(429);
  });

  test("with a key, a push without it is refused", async () => {
    relay.key = "relay-secret";
    try {
      const res = await push(ios("k1"));
      expect(res.status).toBe(401);
      expect((await push(ios("k2"), { authorization: "Bearer relay-secret" })).status).toBe(200);
    } finally {
      relay.key = undefined;
    }
  });

  test("credentials that aren't what Apple or Google made are refused at start", () => {
    expect(() => Apns.create("not a key", "K", "T", "x", base)).toThrow("the APNs key isn't a .p8 file");
    expect(() => Apns.create(rsa.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), "K", "T", "x", base)).toThrow(
      "the APNs key isn't an EC key Apple made",
    );
    expect(() => Fcm.create("{", base)).toThrow("the FCM service account isn't JSON");
    expect(() => Fcm.create(JSON.stringify({ project_id: "p" }), base)).toThrow("the FCM service account has no private_key");
  });
});
