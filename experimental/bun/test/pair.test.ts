import { expect, test } from "bun:test";
import { pairCodes, normalize, newCode, normalizeMac, RedeemError, CODE_TTL_MS, MAC_CODE_TTL_MS } from "../src/hub/pair/codes.ts";
import { Limiter, bucket, macPair, pair } from "../src/hub/pair/http.ts";
import { deepLink, hubUrls, phoneUrl } from "../src/hub/pair/urls.ts";
import { start as startPairLoops } from "../src/hub/pair/loops.ts";
import { sweep } from "../src/hub/sweep/index.ts";
import type { RouteContext } from "../src/hub/http/route.ts";
import type { Hub } from "../src/hub/api/hub.ts";
import { eventsOf, refusal, testHub } from "./people-kit.ts";

const ctx = (hub: Hub, ip = "100.64.0.1") => ({ hub, ip, params: {} }) as unknown as RouteContext;
const post = (path: string, body: unknown, host = "devbox:4790") =>
  new Request(`http://${host}${path}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { host } });

test("new codes are eight Crockford characters split by a hyphen, and parse in any spelling", () => {
  for (let i = 0; i < 200; i++) {
    const code = newCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normalize(code)).toBe(code.replace("-", ""));
  }
  for (const ok of ["0123-ABCD", "0123abcd", "  0123-abcd \n", "oI23-AbCd"]) expect(normalize(ok)).toBe("0123ABCD");
  expect(normalize("OIL3ABCD")).toBe("0113ABCD");
  for (const bad of ["0123-ABC", "0123-ABCDE", "012-3ABCD", "0123--ABCD", "0123-ABCU", "0123 ABCD", ""]) {
    expect(normalize(bad)).toBeUndefined();
  }
  expect(normalizeMac("123 456")).toBe("123456");
  expect(normalizeMac("123-456")).toBe("123456");
  expect(normalizeMac("12345")).toBeUndefined();
});

test("a code redeems once, keeps its role, and expires after fifteen minutes", () => {
  const { hub, clock } = testHub();
  const codes = pairCodes(hub);
  const minted = codes.create("laptop", "operate");
  const stored = hub.db.all<{ hash: string }>("SELECT hash FROM pair_codes")[0]?.hash;
  expect(stored).not.toBe(minted.code.replace("-", ""));
  expect(codes.redeem(minted.code.toLowerCase().replace("-", ""))).toEqual({ name: "laptop", role: "operate" });
  expect(() => codes.redeem(minted.code)).toThrow(RedeemError);
  const late = codes.create(undefined, "admin");
  clock.advance(CODE_TTL_MS);
  try {
    codes.redeem(late.code);
    throw new Error("redeemed");
  } catch (error) {
    expect((error as RedeemError).kind).toBe("expired");
  }
});

test("five failures in a minute block that address, an IPv6 /64 counts together", () => {
  const limiter = new Limiter();
  for (let at = 0; at < 5; at++) {
    expect(limiter.blocked("100.64.0.1", at * 1000)).toBe(false);
    limiter.failed("100.64.0.1", at * 1000);
  }
  expect(limiter.blocked("100.64.0.1", 5000)).toBe(true);
  expect(limiter.blocked("100.64.0.2", 5000)).toBe(false);
  expect(limiter.blocked("100.64.0.1", 60_000)).toBe(false);
  const v6 = new Limiter();
  for (let i = 0; i < 5; i++) v6.failed(`2001:db8:1:2::${(i + 1).toString(16)}`, 0);
  expect(v6.blocked("2001:db8:1:2:ffff::9", 0)).toBe(true);
  expect(v6.blocked("2001:db8:1:3::1", 0)).toBe(false);
  for (let i = 0; i < 5; i++) v6.failed("::ffff:100.64.0.9", 0);
  expect(v6.blocked("100.64.0.9", 0)).toBe(true);
  expect(bucket("::ffff:10.0.0.1")).toBe("10.0.0.1");
});

test("POST /pair trades a code for a human key of the owner, says where the hub is, and logs key.paired", async () => {
  const { hub } = testHub({ url: "http://devbox:4790" });
  const minted = pairCodes(hub).create(undefined, "admin");
  const res = (await pair(post("/pair", { code: minted.code, deviceName: " phone\u0007 " }), ctx(hub))) as Response;
  expect(res.status).toBe(200);
  const body = (await res.json()) as { key: string; hubUrl: string; hubName: string };
  expect(body.hubUrl).toBe("http://devbox:4790");
  expect(body.hubName).toStartWith("fleetd-");
  const caller = hub.auth.verify(body.key);
  expect(caller.kind).toBe("human");
  expect(caller.name).toBe("phone");
  expect(caller.person?.personId).toMatch(/^p_/);
  const [paired] = eventsOf(hub, "key.paired");
  expect(paired?.summary).toBe("phone paired with the hub");
  expect(paired?.data).toEqual({ keyId: caller.keyId, deviceName: "phone", personId: caller.person?.personId, inviteId: null });

  const again = (await pair(post("/pair", { code: minted.code }), ctx(hub))) as Response;
  expect(again.status).toBe(401);
  expect(await again.json()).toEqual({
    code: "pair_code_invalid",
    message: "unknown or already used pairing code",
    fix: "Run `fleetd pair` on the hub for a new code, or ask whoever invited you for a new invite.",
  });
  const bad = (await pair(post("/pair", "{}"), ctx(hub))) as Response;
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { message: string }).message).toBe(
    'expected {"code": "XXXX-XXXX", "deviceName": "…"}: missing field `code`',
  );
  for (let i = 0; i < 4; i++) await pair(post("/pair", { code: "0000-0000" }), ctx(hub));
  const limited = (await pair(post("/pair", { code: "0000-0000" }), ctx(hub))) as Response;
  expect(limited.status).toBe(429);
});

test("a hub on every interface with no URL answers with the address the device used", async () => {
  const { hub } = testHub({ host: "0.0.0.0" });
  const minted = pairCodes(hub).create(undefined, "read");
  const res = (await pair(post("/pair", { code: minted.code }, "100.64.0.5:4790"), ctx(hub))) as Response;
  expect(((await res.json()) as { hubUrl: string }).hubUrl).toBe("http://100.64.0.5:4790");
});

test("pair a phone mints a code for the caller's own person at the app's address, never loopback", async () => {
  const { hub, call, device, agent } = testHub();
  const me = device();
  const out = await call<{ code: string; hubUrl: string; link: string }>(me, "pair_code_create", { hubUrl: "http://devbox:4790/" });
  expect(out.hubUrl).toBe("http://devbox:4790");
  expect(out.link).toBe(`fleetd://pair?hub=http%3A%2F%2Fdevbox%3A4790&code=${out.code}`);
  expect(pairCodes(hub).redeem(out.code)).toEqual({ role: "admin", personId: me.person?.personId as string });
  // Saved without its scheme: http's.
  expect((await call<{ hubUrl: string }>(me, "pair_code_create", { hubUrl: "devbox:4790" })).hubUrl).toBe("http://devbox:4790");
  const loopback = await refusal(call(me, "pair_code_create", { hubUrl: "http://127.0.0.1:4790" }));
  expect(loopback.message).toBe("The hub is only at http://127.0.0.1:4790, which a phone can't reach.");
  expect((await refusal(call(agent(), "pair_code_create", {}))).message).toBe("Only a person's own device pairs a phone.");
  const some = device([{ role: "admin", machines: ["lab-a"] }]);
  expect((await refusal(call(some, "pair_code_create", { hubUrl: "http://devbox:4790" }))).code).toBe("forbidden");
});

test("an admin's Mac code trades once at /pair/mac for an enroll token, and refuses another computer first", async () => {
  const { hub, call, device } = testHub({ url: "http://devbox:4790" });
  const admin = device();
  const out = await call<{ code: string; machineId: string; hubUrl: string }>(admin, "mac_code_create", {});
  expect(out.code).toMatch(/^\d{6}$/);
  expect(out.machineId).toBe("mac");
  expect(out.hubUrl).toBe("http://devbox:4790");
  expect(await call(admin, "mac_code_status", { code: out.code })).toEqual({ state: "open" });

  hub.db.conn.run("INSERT INTO node_keys (machine_id, pub_key, fingerprint) VALUES ('mac', 'k', 'theirs')");
  const other = (await macPair(post("/pair/mac", { code: out.code, fingerprint: "ours" }), ctx(hub))) as Response;
  expect(other.status).toBe(409);
  expect(((await other.json()) as { code: string }).code).toBe("mac_other_computer");
  expect(await call(admin, "mac_code_status", { code: out.code })).toEqual({ state: "open" });

  const res = (await macPair(post("/pair/mac", { code: `${out.code.slice(0, 3)} ${out.code.slice(3)}`, fingerprint: "theirs" }), ctx(hub))) as Response;
  expect(res.status).toBe(200);
  const body = (await res.json()) as { machineId: string; token: string; existing: boolean; version: string };
  expect(body.machineId).toBe("mac");
  expect(body.token).toStartWith("fle_");
  expect(body.existing).toBe(false);
  expect(await call(admin, "mac_code_status", { code: out.code })).toEqual({ state: "used" });
  expect((await refusal(call(device([{ role: "operate", machines: "*" }]), "mac_code_create", {}))).code).toBe("forbidden");
});

test("wrong Mac codes close the open one at the tenth, and a new code revokes the old", () => {
  const { hub } = testHub();
  const codes = pairCodes(hub);
  const first = codes.createMac("mac");
  const second = codes.createMac("mac");
  expect(codes.macState(first.code === second.code ? "000000x" : first.code)).toBe(first.code === second.code ? undefined : "revoked");
  for (let i = 0; i < 10; i++) codes.failedMac();
  expect(codes.macState(second.code)).toBe("closed");
  expect(codes.openMac()).toBeUndefined();
  const third = codes.createMac("mac");
  expect(codes.openMac()?.machineId).toBe("mac");
  expect(codes.revokeMac(codes.openMac()?.id as string)).toBe("mac");
  expect(codes.macState(third.code)).toBe("revoked");
  const fourth = codes.createMac("mac");
  (hub.clock as unknown as { advance(ms: number): void }).advance(MAC_CODE_TTL_MS);
  expect(codes.macState(fourth.code)).toBe("expired");
});

test("the sweep drops codes spent a day ago and keeps open ones", async () => {
  const { hub, clock } = testHub();
  startPairLoops(hub);
  const codes = pairCodes(hub);
  const spent = codes.create(undefined, "read");
  codes.redeem(spent.code);
  clock.advance(24 * 60 * 60_000 + 1);
  codes.create(undefined, "read");
  await sweep(hub).runOnce();
  expect(hub.db.all("SELECT 1 FROM pair_codes").length).toBe(1);
});

test("hub addresses rank tailnet first and a phone never gets loopback", () => {
  expect(hubUrls("0.0.0.0", 4790, undefined, "100.100.1.2", "192.168.1.5")).toEqual([
    "http://100.100.1.2:4790",
    "http://192.168.1.5:4790",
    "http://127.0.0.1:4790",
  ]);
  expect(hubUrls("127.0.0.1", 4790, "http://devbox.example.ts.net:4790/", undefined, undefined)).toEqual([
    "http://devbox.example.ts.net:4790",
    "http://127.0.0.1:4790",
  ]);
  expect(phoneUrl(["http://127.0.0.1:4790", "http://[::1]:4790", "http://localhost:1", "http://0.0.0.0:4790", "http://devbox:4790"])).toBe(
    "http://devbox:4790",
  );
  expect(deepLink("http://a b", "X")).toBe("fleetd://pair?hub=http%3A%2F%2Fa+b&code=X");
});
