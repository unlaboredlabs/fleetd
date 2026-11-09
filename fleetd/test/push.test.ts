import { afterAll, expect, test } from "bun:test";
import { openSealed, publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import { approvalNotice, Follow, payloadJson, PUSH_PAYLOAD_MAX, recipients, step, type PushPayload } from "../src/hub/push/index.ts";
import { boxKey } from "../src/hub/hub_links/store.ts";
import { events } from "../src/hub/store/events.ts";
import { people } from "../src/hub/people/store.ts";
import { refusal, testHub } from "./people-kit.ts";
import { tempHome } from "./helpers.ts";

/** A fake push relay: answers each push as `answer` says, and keeps what it got. Never the real relay. */
const got: { body: Record<string, string>; auth: string | null }[] = [];
let answer: (token: string) => Record<string, string> = () => ({ status: "sent" });
const relayServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as Record<string, string>;
    got.push({ body, auth: req.headers.get("authorization") });
    return Response.json(answer(body.token as string));
  },
});
const RELAY = `http://127.0.0.1:${relayServer.port}`;
const homes: (() => void)[] = [];
afterAll(() => {
  relayServer.stop(true);
  for (const done of homes) done();
});

function setup() {
  const home = tempHome();
  homes.push(home.done);
  const kit = testHub({ home: home.dir, url: "http://devbox:4790" });
  const owner = kit.device(undefined, people(kit.hub).list(false)[0]?.personId, "phone");
  return { ...kit, owner };
}

const phoneKey = () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  return { secret, pub: Buffer.from(publicKeyOf(secret)).toString("base64") };
};

test("a registered phone gets an alert sealed to it, with its badge, and the relay sees only ciphertext", async () => {
  const { hub, call, owner } = setup();
  const phone = phoneKey();
  const reg = await call<{ device: { deviceId: string }; relay: boolean }>(owner, "push_device_register", {
    platform: "ios",
    token: "tok-1",
    publicKey: phone.pub,
    name: "iPhone",
  });
  expect(reg.relay).toBe(true);
  await call(owner, "push_relay_set", { url: `${RELAY}/` });
  got.length = 0;
  events(hub).append({ at: "2026-11-08T10:00:00.000Z", type: "machine.offline", summary: "lab-a is down", attention: "loud" });
  events(hub).append({ at: "2026-11-08T10:00:01.000Z", type: "machine.online", summary: "nothing for a person" });
  const out = await step(hub, new Follow(RELAY), 0);
  expect(out.outcomes).toEqual([[reg.device.deviceId, { kind: "sent" }]]);
  expect(got.length).toBe(1);
  expect(got[0]?.body.token).toBe("tok-1");
  expect(got[0]?.body.platform).toBe("ios");
  expect(got[0]?.auth).toBeNull();
  const plain = openSealed(phone.secret, Buffer.from(got[0]?.body.ciphertext as string, "base64"));
  const payload = JSON.parse(new TextDecoder().decode(plain as Uint8Array)) as PushPayload;
  expect(payload).toMatchObject({ v: 1, kind: "alert", title: "fleetd", body: "lab-a is down", hub: "http://devbox:4790", badge: 0 });
  const listed = await call<{ devices: { lastSentAt?: string }[] }>(owner, "push_devices_list");
  expect(listed.devices[0]?.lastSentAt).toBeDefined();
});

test("a dead token is dropped, unless most of a person's phones die at once", async () => {
  const { hub, call, owner } = setup();
  for (const token of ["a", "b", "c"]) {
    await call(owner, "push_device_register", { platform: "android", token, publicKey: phoneKey().pub, name: token });
  }
  await call(owner, "push_relay_set", { url: RELAY });
  answer = (token) => ({ status: token === "a" ? "dead" : "sent" });
  events(hub).append({ at: "2026-11-08T10:00:00.000Z", type: "machine.offline", summary: "x", attention: "loud" });
  await step(hub, new Follow(RELAY), 0);
  expect((await call<{ devices: unknown[] }>(owner, "push_devices_list")).devices.length).toBe(2);
  answer = () => ({ status: "dead" });
  const head = events(hub).head();
  events(hub).append({ at: "2026-11-08T10:00:01.000Z", type: "machine.offline", summary: "y", attention: "loud" });
  const warn = console.warn;
  console.warn = () => {};
  const out = await step(hub, new Follow(RELAY), head);
  console.warn = warn;
  expect(out.outcomes.every(([, o]) => o.kind === "failed")).toBe(true);
  expect((await call<{ devices: unknown[] }>(owner, "push_devices_list")).devices.length).toBe(2);
  answer = () => ({ status: "sent" });
});

test("the relay's key is sealed to the hub, sent as a bearer, and the default relay refuses a key or plain http", async () => {
  const { hub, call, owner, agent } = setup();
  await call(owner, "push_device_register", { platform: "ios", token: "t", publicKey: phoneKey().pub, name: "p" });
  const sealed = Buffer.from(seal(publicKeyOf(boxKey(hub)), new TextEncoder().encode("relay-secret\n"))).toString("base64");
  expect(await call(owner, "push_relay_set", { url: RELAY, key: sealed })).toEqual({ default: false, key: true, url: RELAY });
  got.length = 0;
  events(hub).append({ at: "2026-11-08T10:00:00.000Z", type: "machine.offline", summary: "x", attention: "loud" });
  await step(hub, new Follow(RELAY), 0);
  expect(got[0]?.auth).toBe("Bearer relay-secret");
  expect((await refusal(call(owner, "push_relay_set", { url: "http://push.fleetd.sh" }))).message).toBe(
    "https://push.fleetd.sh takes pushes over https, without a key.",
  );
  expect((await refusal(call(owner, "push_relay_set", { url: "ftp://x" }))).message).toBe("ftp://x isn't an http(s) URL.");
  expect(await call(owner, "push_relay_set", { url: "https://push.fleetd.sh" })).toEqual({ default: true, key: false, url: "https://push.fleetd.sh" });
  expect(await call(owner, "push_relay_set", { url: "" })).toEqual({ default: false, key: false });
  expect((await call<{ relay: boolean }>(owner, "push_devices_list")).relay).toBe(false);
  expect((await refusal(call(agent(), "push_devices_list"))).code).toBe("forbidden");
});

test("a phone's register checks its key and token, and a person holds at most 20", async () => {
  const { call, owner } = setup();
  expect((await refusal(call(owner, "push_device_register", { platform: "ios", token: "t", publicKey: "AAAA", name: "p" }))).message).toBe(
    "publicKey isn't an X25519 public key.",
  );
  expect((await refusal(call(owner, "push_device_register", { platform: "ios", token: "a b", publicKey: phoneKey().pub, name: "p" }))).message).toBe(
    "token isn't a push token.",
  );
  for (let i = 0; i < 20; i++) await call(owner, "push_device_register", { platform: "ios", token: `t${i}`, publicKey: phoneKey().pub, name: "p" });
  expect((await refusal(call(owner, "push_device_register", { platform: "ios", token: "t20", publicKey: phoneKey().pub, name: "p" }))).message).toBe(
    "You have 20 phones registered already.",
  );
  // The same token again is the same phone.
  await call(owner, "push_device_register", { platform: "ios", token: "t3", publicKey: phoneKey().pub, name: "renamed" });
});

test("an approval is approved from the notification only when the body is its whole command", () => {
  const base = { requestId: "Q1", projectRef: { machineId: "m", projectId: "p" }, state: "open", createdAt: "x", text: "Deploy it." };
  const gated = (argv: string[], cls = "normal") =>
    approvalNotice({ ...base, kind: "gated_run", gated: { argv, class: cls, reason: "r", timeoutSec: 60 } } as never);
  expect(gated(["git", "push"])).toEqual(["Deploy it: git push", "approve"]);
  expect(gated(["rm", "-rf", "x"], "irreversible")).toEqual(["Deploy it: rm -rf x", "review"]);
  expect(gated(["echo", "a\u202Eb"])[1]).toBe("review");
  expect(gated(["echo", "two words"])).toEqual(['Deploy it: echo "two words"', "approve"]);
  expect(approvalNotice({ ...base, kind: "secret" } as never)).toEqual(["Deploy it", undefined]);
  const long = payloadJson({ v: 1, kind: "approval", title: "t", body: "x ".repeat(3000), hub: "h", category: "approve", at: "a" });
  const parsed = JSON.parse(new TextDecoder().decode(long)) as PushPayload;
  expect(long.length).toBeLessThanOrEqual(PUSH_PAYLOAD_MAX);
  expect(parsed.category).toBe("review");
  expect(parsed.body.endsWith("…")).toBe(true);
});

test("an event about no project goes to owners and admins; a project's to who last wrote in its chat", () => {
  const { hub } = setup();
  const admin = people(hub).create("Ada", "admin");
  const member = people(hub).create("Mo", "member");
  const owner = people(hub).list(false)[0]?.personId as string;
  expect(recipients(hub.db.conn, undefined)).toEqual([owner, admin.personId]);
  const r = { machineId: "m", projectId: "p" };
  expect(recipients(hub.db.conn, r)).toEqual([owner]);
  hub.db.conn.run(
    `INSERT INTO chat_messages (machine_id, project_id, seq, created_ms, data) VALUES ('m', 'p', 1, 1, '{"author":"human","person":{"personId":"${member.personId}","name":"Mo"}}')`,
  );
  expect(recipients(hub.db.conn, r)).toEqual([member.personId]);
});
