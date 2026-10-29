// Push against a fake hub and fake OS (real APNs and FCM can't be reached from a test): the hub's sealed boxes, what
// shows for them, registering and re-registering on a new token, tap routing and signing out.
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubClient } from "./hub/client";
import { fakeHub } from "./hub/fake";
import fixture from "./push.fixture.json";
import { androidShown, openPayload, registerDevice, shownOf, tapRoute, type PushDeps } from "./push";
import { fromBase64, keyPairOf, seal, toBase64, type KeyPair } from "./seal";
import { Session } from "./session";

const keys = keyPairOf(fromBase64(fixture.secretKey)!);
const [message, approval] = fixture.cases;
const sealedJson = (json: unknown, to: KeyPair = keys) => toBase64(seal(new TextEncoder().encode(JSON.stringify(json)), to.publicKey));

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("the hub's sealed boxes", () => {
  it("show nothing on Android unless they open with this phone's keys", () => {
    expect(androidShown({ c: message!.ciphertext }, keys)).toMatchObject({ title: "Ada", body: "Your flight moved to 9:40." });
    expect(androidShown({ data: { c: message!.ciphertext } }, keys)).not.toBeNull();
    // Anyone with the token can post to the public relay: what they seal to another key, or send unsealed, shows nothing.
    const stranger = nacl.box.keyPair();
    expect(androidShown({ c: sealedJson({ v: 1, kind: "message", title: "Bank", body: "Call us", hub: "", at: "" }, stranger) }, keys)).toBeNull();
    expect(androidShown({ c: toBase64(new TextEncoder().encode('{"v":1,"title":"Bank","body":"Call us"}')) }, keys)).toBeNull();
    expect(androidShown({ c: "not base64!" }, keys)).toBeNull();
    expect(androidShown({ title: "Bank", body: "Call us" }, keys)).toBeNull();
    expect(androidShown({ c: message!.ciphertext }, null)).toBeNull();
    expect(androidShown({ c: sealedJson({ v: 2, kind: "message", title: "Ada", body: "Hi", hub: "", at: "" }) }, keys)).toBeNull();
  });

  it("open with the phone's secret key, whose public key is the one the hub sealed to", () => {
    expect(toBase64(keys.publicKey)).toBe(fixture.publicKey);
    expect(openPayload(message!.ciphertext, keys)).toEqual(JSON.parse(message!.plaintext));
    expect(openPayload(approval!.ciphertext, keys)).toMatchObject({ kind: "approval", body: "Send an email to landlord@example.com — naïve café ✓", requestId: "Q7", urgent: true });
  });

  it("don't open with another key, cut or changed", () => {
    expect(openPayload(message!.ciphertext, nacl.box.keyPair())).toBeNull();
    const bytes = fromBase64(message!.ciphertext)!;
    bytes[60] = bytes[60]! ^ 1;
    expect(openPayload(toBase64(bytes), keys)).toBeNull();
    expect(openPayload(toBase64(bytes.subarray(0, 40)), keys)).toBeNull();
    expect(openPayload("not base64!", keys)).toBeNull();
  });

  it("don't open a newer version's, and show an unknown kind as an alert", () => {
    expect(openPayload(sealedJson({ v: 2, kind: "message", title: "Ada", body: "Hi", hub: "", at: "" }), keys)).toBeNull();
    expect(openPayload(sealedJson({ v: 1, kind: "poll", title: "Ada", body: "Hi", hub: "", at: "" }), keys)?.kind).toBe("alert");
  });
});

describe("what a notification shows", () => {
  it("is one per chat, on the quiet channel inside quiet hours", () => {
    expect(shownOf(openPayload(message!.ciphertext, keys)!)).toEqual({
      title: "Ada",
      body: "Your flight moved to 9:40.",
      channel: "quiet",
      urgent: false,
      id: "chat:devbox/navi-ada",
      route: { t: "chat", key: "devbox/navi-ada" },
    });
  });

  it("is one per request for an approval, urgent when it costs money or can't be undone", () => {
    expect(shownOf(openPayload(approval!.ciphertext, keys)!)).toMatchObject({
      channel: "approvals",
      urgent: true,
      id: "approval:Q7",
      route: { t: "approval", requestId: "Q7", key: "devbox/shop" },
    });
    expect(shownOf(openPayload(sealedJson({ v: 1, kind: "order", title: "fleetd", body: "Order landed", hub: "", at: "" }), keys)!)).toEqual({
      title: "fleetd",
      body: "Order landed",
      channel: "other",
      urgent: false,
    });
  });
});

describe("tapping a notification", () => {
  it("opens the chat or the approval an Android notification carries", () => {
    expect(tapRoute({ route: { t: "chat", key: "devbox/navi-ada" } }, undefined, null)).toEqual({ t: "chat", key: "devbox/navi-ada" });
    expect(tapRoute({ route: { t: "approval", requestId: "Q7" } }, undefined, null)).toEqual({ t: "approval", requestId: "Q7" });
  });

  it("opens again the payload iOS showed, from its APNs userInfo", () => {
    const userInfo = { aps: { alert: { title: "fleetd", body: "New activity" }, "mutable-content": 1 }, c: approval!.ciphertext };
    expect(tapRoute({}, userInfo, keys)).toEqual({ t: "approval", requestId: "Q7", key: "devbox/shop" });
    expect(tapRoute({}, { data: { c: message!.ciphertext } }, keys)).toEqual({ t: "chat", key: "devbox/navi-ada" });
  });

  it("just opens the app for one it can't read", () => {
    expect(tapRoute({}, { c: message!.ciphertext }, null)).toBeUndefined();
    expect(tapRoute({ route: { t: "chat", key: "nokey" } }, {}, keys)).toBeUndefined();
    expect(tapRoute(null, null, keys)).toBeUndefined();
  });
});

const fakeOs = (first: string | null = "a1b2c3") => {
  let token = first;
  const listeners = new Set<(token: string) => void>();
  const saved: string[] = [];
  const deps: PushDeps = {
    platform: "ios",
    deviceName: "Ada's iPhone",
    keys: async () => keys,
    token: async () => token,
    onToken: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    saveDevice: async (id) => void saved.push(id),
    loadDevice: async () => saved.at(-1) ?? null,
  };
  const newToken = (t: string) => {
    token = t;
    listeners.forEach((l) => l(t));
  };
  return { deps, saved, newToken, listeners };
};

const SNAPSHOT = { t: "snapshot", cursor: 1, attention: [], machines: [], projects: [], chats: [] };
const device = (deviceId: string) => ({ device: { deviceId, platform: "ios", name: "Ada's iPhone", createdAt: "2026-10-28T10:00:00Z" }, relay: true });
const calls = (hub: ReturnType<typeof fakeHub>, tool: string) => hub.links.flatMap((l) => l.sent).filter((m) => m.t === "call" && m.tool === tool);
const registers = (hub: ReturnType<typeof fakeHub>) => calls(hub, "push_device_register");

describe("registering the phone", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends its platform, token, public key and name, and keeps the hub's id for it", async () => {
    const hub = fakeHub();
    const os = fakeOs();
    const session = new Session({ hub: "http://devbox:4790", key: "fld_abcdefxyz", transport: hub.transport, push: os.deps });
    session.start();
    hub.ready();
    await flush();
    expect(registers(hub)).toMatchObject([{ input: { platform: "ios", token: "a1b2c3", publicKey: fixture.publicKey, name: "Ada's iPhone" } }]);
    hub.answer("push_device_register", device("pd_aaaaaaaa"));
    await flush();
    expect(os.saved).toEqual(["pd_aaaaaaaa"]);
    session.stop();
    expect(os.listeners.size).toBe(0);
  });

  it("registers again with each new token, now when live or on the next link", async () => {
    const hub = fakeHub();
    const os = fakeOs();
    const session = new Session({ hub: "http://devbox:4790", key: "fld_abcdefxyz", transport: hub.transport, push: os.deps });
    session.start();
    hub.ready();
    hub.link.frame(SNAPSHOT);
    await flush();
    os.newToken("d4e5f6");
    await flush();
    expect(registers(hub).map((c) => (c.input as { token: string }).token)).toEqual(["a1b2c3", "d4e5f6"]);
    hub.link.close(1006);
    os.newToken("070809");
    await flush();
    vi.advanceTimersByTime(1000);
    hub.ready();
    await flush();
    expect(registers(hub).map((c) => (c.input as { token: string }).token)).toEqual(["a1b2c3", "d4e5f6", "070809"]);
  });

  it("registers nothing without a token: notifications not allowed, or no Firebase config", async () => {
    const hub = fakeHub();
    const os = fakeOs(null);
    const session = new Session({ hub: "http://devbox:4790", key: "fld_abcdefxyz", transport: hub.transport, push: os.deps });
    session.start();
    hub.ready();
    await flush();
    expect(registers(hub)).toEqual([]);
  });

  it("says when the hub refused it", async () => {
    const hub = fakeHub();
    const os = fakeOs();
    const client = new HubClient({ hub: "http://devbox:4790", key: "k", transport: hub.transport, emit: () => {} });
    client.start();
    hub.ready();
    const r = registerDevice(client, os.deps);
    await flush();
    hub.fail("push_device_register", "forbidden", "An agent key has no phone.");
    expect(await r).toEqual({ t: "failed", error: { code: "forbidden", message: "An agent key has no phone." } });
  });
});

describe("Disconnect", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("removes the phone's push registration, then revokes its own key", async () => {
    const hub = fakeHub();
    const os = fakeOs();
    await os.deps.saveDevice("pd_aaaaaaaa");
    const session = new Session({ hub: "http://devbox:4790", key: "fld_abcdefxyz", transport: hub.transport, push: os.deps });
    session.start();
    hub.ready();
    const out = session.signOut();
    await flush();
    expect(calls(hub, "push_device_remove")).toMatchObject([{ input: { deviceId: "pd_aaaaaaaa" } }]);
    hub.answer("push_device_remove", device("pd_aaaaaaaa"));
    await flush();
    const person = { personId: "pr_ada", name: "Ada" };
    const key = (keyId: string, prefix: string, who = person) => ({ keyId, prefix, kind: "human", name: keyId, grants: [], createdAt: "2026-10-28T10:00:00Z", person: who });
    hub.answer("people_list", {
      me: "pr_ada",
      people: [],
      invites: [],
      devices: [key("k1", "fld_qqqqqq"), key("k2", "fld_abcdef", { personId: "pr_bob", name: "Bob" }), key("k3", "fld_abcdef")],
    });
    await flush();
    expect(calls(hub, "device_revoke")).toMatchObject([{ input: { keyId: "k3" } }]);
    hub.answer("device_revoke", { device: key("k3", "fld_abcdef") });
    expect(await out).toEqual({ ok: true });
  });

  it("fails without the hub, for the app to offer forgetting it anyway", async () => {
    const hub = fakeHub();
    const os = fakeOs();
    await os.deps.saveDevice("pd_aaaaaaaa");
    const session = new Session({ hub: "http://devbox:4790", key: "fld_abcdefxyz", transport: hub.transport, push: os.deps });
    session.start();
    expect(await session.signOut()).toMatchObject({ ok: false, error: { code: "offline" } });
  });
});
