// Push against a fake hub and fake OS (real APNs and FCM can't be reached from a test): the hub's sealed boxes, what
// shows for them, registering and re-registering on a new token, tap routing and signing out.
import nacl from "tweetnacl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardOf, landingOf } from "./chatView";
import type { ChatMessage, HumanRequest } from "./desktop";
import { HubClient } from "./hub/client";
import { fakeHub } from "./hub/fake";
import fixture from "./push.fixture.json";
import { READY_TIMEOUT_MS } from "./hub/client";
import {
  act,
  actOf,
  androidShown,
  CATEGORIES,
  categoryOf,
  chatAt,
  openPayload,
  opensRoute,
  pushedPayload,
  registerDevice,
  shownOf,
  tapRoute,
  type PushDeps,
  type PushPayload,
} from "./push";
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
      payload: JSON.parse(message!.plaintext),
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
      payload: { v: 1, kind: "order", title: "fleetd", body: "Order landed", hub: "", at: "" },
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

  it("opens an approval's chat, scrolled to the card that answers it", () => {
    const userInfo = { aps: { alert: { title: "fleetd", body: "New activity" }, "mutable-content": 1 }, c: approval!.ciphertext };
    const route = tapRoute({}, userInfo, keys);
    const at = route === undefined ? undefined : chatAt(route, undefined);
    expect(at).toEqual({ key: "devbox/shop", requestId: "Q7" });
    // The chat lands on the message whose card asks it, not on another approval's or a plain message.
    const said = (messageId: string, item?: ChatMessage["item"]) => ({ message: { messageId, ...(item === undefined ? {} : { item }) } as ChatMessage });
    const card = (requestId: string) => ({ kind: "command_approval", requestId, machineId: "devbox", state: "open" }) as ChatMessage["item"];
    expect(cardOf([said("m1"), said("m2", card("Q6")), said("m3", card("Q7")), said("m4")], at!.requestId!)).toBe("m3");
    expect(cardOf([said("m1")], "Q7")).toBeUndefined();
    // A card further back than the pages read: one more page, till it's in; then on it.
    const newest = [said("m5"), said("m6")];
    expect(landingOf(newest, at!, { hasOlder: true, failed: false })).toBe("older");
    expect(landingOf([said("m3", card("Q7")), ...newest], at!, { hasOlder: true, failed: false })).toBe("m3");
    // Not in the chat at all, or its page can't be read now: the chat opens as usual.
    expect(landingOf(newest, at!, { hasOlder: false, failed: false })).toBeUndefined();
    expect(landingOf(newest, at!, { hasOlder: true, failed: true })).toBeUndefined();
    expect(landingOf(newest, { messageId: "m6" }, { hasOlder: true, failed: false })).toBe("m6");
    expect(chatAt({ t: "chat", key: "devbox/navi-ada" }, undefined)).toEqual({ key: "devbox/navi-ada" });
  });

  it("finds the chat of an approval that didn't say it among the open requests, once they're read", () => {
    const open = { requestId: "Q7", kind: "approval", state: "open", projectRef: { machineId: "devbox", projectId: "shop" }, createdAt: "2026-10-28T10:00:00Z", text: "Deploy" } as HumanRequest;
    expect(chatAt({ t: "approval", requestId: "Q7" }, undefined)).toBeUndefined();
    expect(chatAt({ t: "approval", requestId: "Q7" }, [open])).toEqual({ key: "devbox/shop", requestId: "Q7" });
    // Answered meanwhile: the app just opens.
    expect(chatAt({ t: "approval", requestId: "Q7" }, [])).toBeNull();
  });

  it("opens the live view of a screen whose agent asks for you, over its chat", () => {
    const sessionId = "B0123456789abcdef0123456789abcdef";
    const p = { v: 1, kind: "alert", title: "Nova", body: "Needs you on its screen: Solve the captcha on booking.com", hub: "", machineId: "devbox", projectId: "navi-ada", sessionId, at: "" };
    const shown = shownOf(openPayload(sealedJson(p), keys)!);
    expect(shown).toMatchObject({ title: "Nova", channel: "other", id: `screen:${sessionId}`, route: { t: "screen", key: "devbox/navi-ada", sessionId } });
    expect(chatAt(shown.route!, undefined)).toEqual({ key: "devbox/navi-ada", sessionId });
    // Android's posted notification carries the route; iOS's opens the payload again.
    expect(tapRoute({ route: shown.route }, undefined, null)).toEqual(shown.route);
    expect(tapRoute({}, { c: sealedJson(p) }, keys)).toEqual(shown.route);
    // Not a screen's id: just its chat.
    expect(shownOf(openPayload(sealedJson({ ...p, sessionId: "../x" }), keys)!).route).toEqual({ t: "chat", key: "devbox/navi-ada" });
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

describe("a notification's buttons", () => {
  const DEFAULT = "expo.modules.notifications.actions.DEFAULT";
  const base = { v: 1, title: "app", hub: "http://devbox:4790", machineId: "devbox", projectId: "app", at: "2026-10-29T08:00:00.000Z" } as const;
  const push: PushPayload = { ...base, kind: "approval", body: "Push the fix: git push", requestId: "Q3", category: "approve", badge: 2 };
  const deploy: PushPayload = { ...base, kind: "approval", body: "Ship it: ./deploy.sh prod", requestId: "Q4", category: "review", urgent: true };
  const said: PushPayload = { ...base, kind: "message", title: "Ada", projectId: "navi", body: "Which flight?", category: "reply", badge: 1 };
  const route = { t: "approval", requestId: "Q3", key: "devbox/app" } as const;

  it("come from the sealed payload, and a field this app doesn't know is left out", () => {
    const opened = openPayload(sealedJson({ ...push, colour: "red" }), keys);
    expect(opened).toEqual(push);
    expect(openPayload(sealedJson({ ...push, category: "bounce", badge: -1 }), keys)).not.toHaveProperty("category");
    expect(openPayload(sealedJson({ ...push, badge: 1.5 }), keys)).not.toHaveProperty("badge");
    expect(shownOf(push)).toMatchObject({ category: "fleetd.approve", badge: 2 });
    expect(shownOf(said)).toMatchObject({ category: "fleetd.reply", badge: 1 });
  });

  it("are Approve and Deny, unlocked first, only where the hub marked them; money or irreversible is reviewed in the app", () => {
    expect(categoryOf(push)).toBe("fleetd.approve");
    expect(categoryOf(deploy)).toBe("fleetd.review");
    // Whatever an urgent one says, it shows its full card first (D183/D193).
    expect(categoryOf({ ...deploy, category: "approve" })).toBe("fleetd.review");
    const { category: _, ...unmarked } = push;
    expect(categoryOf(unmarked)).toBeUndefined();
    expect(CATEGORIES["fleetd.approve"].every((a) => a.options.isAuthenticationRequired && !a.options.opensAppToForeground)).toBe(true);
    expect(CATEGORIES["fleetd.review"]).toEqual([{ identifier: "review", buttonTitle: "Review", options: { opensAppToForeground: true } }]);
    expect(CATEGORIES["fleetd.reply"][0]).toMatchObject({ identifier: "reply", textInput: { submitButtonTitle: "Send" }, options: { isAuthenticationRequired: true } });
  });

  it("open the app on a tap or Review, and act on the others", () => {
    expect(opensRoute(DEFAULT, DEFAULT)).toBe(true);
    expect(opensRoute("review", DEFAULT)).toBe(true);
    expect(opensRoute("approve", DEFAULT)).toBe(false);
    expect(actOf("approve", undefined, push)).toEqual({ t: "approve", requestId: "Q3", route });
    expect(actOf("deny", undefined, push)).toEqual({ t: "deny", requestId: "Q3", route });
    expect(actOf("reply", "  The 9:40 one ", said)).toEqual({ t: "reply", key: "devbox/navi", text: "The 9:40 one" });
    expect(actOf("reply", " ", said)).toBeUndefined();
    expect(actOf(DEFAULT, undefined, push)).toBeUndefined();
    // iOS's payload is opened again from the APNs userInfo; Android's notification carries it.
    expect(pushedPayload({ c: sealedJson(push) }, {}, keys)).toEqual(push);
    expect(pushedPayload(undefined, { payload: push }, null)).toEqual(push);
    expect(pushedPayload({ c: sealedJson(push) }, {}, null)).toBeNull();
  });

  it("approve with the phone's key, say so where the notification was and set the badge", async () => {
    const hub = fakeHub();
    const out = act({ t: "approve", requestId: "Q3", route }, push, { hub: "http://devbox:4790", key: "fld_phone", transport: hub.transport }, () => "c1");
    hub.ready();
    await flush();
    expect(calls(hub, "approval_answer")).toMatchObject([{ input: { requestId: "Q3", decision: "approve" } }]);
    hub.answer("approval_answer", { request: { requestId: "Q3", state: "approved" } });
    await flush();
    hub.answer("push_badge", { badge: 1 });
    expect(await out).toEqual({ followUp: { title: "app", body: "Approved: Push the fix: git push", route }, badge: 1 });
    expect(hub.link.closed).toBe(true);
  });

  it("say so when the approved command didn't run, as its machine was offline", async () => {
    const hub = fakeHub();
    const out = act({ t: "approve", requestId: "Q3", route }, push, { hub: "http://devbox:4790", key: "fld_phone", transport: hub.transport }, () => "c1");
    hub.ready();
    await flush();
    hub.answer("approval_answer", { request: { requestId: "Q3", state: "open", evidence: "not run: devbox's node was offline when human:phone approved it" } });
    await flush();
    hub.answer("push_badge", { badge: 2 });
    expect(await out).toEqual({ followUp: { title: "app", body: "Not run: devbox's node was offline when human:phone approved it", route }, badge: 2 });
  });

  it("deny, and say why when the hub refused", async () => {
    const hub = fakeHub();
    const out = act({ t: "deny", requestId: "Q3", route }, push, { hub: "http://devbox:4790", key: "fld_phone", transport: hub.transport }, () => "c1");
    hub.ready();
    await flush();
    expect(calls(hub, "approval_answer")).toMatchObject([{ input: { requestId: "Q3", decision: "deny" } }]);
    hub.fail("approval_answer", "conflict", "Already answered on the desktop.");
    await flush();
    hub.answer("push_badge", { badge: 0 });
    expect(await out).toEqual({ followUp: { title: "app", body: "Not denied: Already answered on the desktop.", route }, badge: 0 });
  });

  it("never approve money or an irreversible command from the notification: it asks to open the app", async () => {
    const hub = fakeHub();
    const r = { t: "approval", requestId: "Q4", key: "devbox/app" } as const;
    const out = await act({ t: "approve", requestId: "Q4", route: r }, { ...deploy, category: "approve" }, { hub: "http://devbox:4790", key: "fld_phone", transport: hub.transport }, () => "c1");
    expect(hub.links).toEqual([]);
    expect(out).toEqual({ followUp: { title: "app", body: "Open fleetd to review it on its full card: Ship it: ./deploy.sh prod", route: r } });
  });

  it("reply into the chat, and say so when it wasn't sent", async () => {
    const hub = fakeHub();
    const link = { hub: "http://devbox:4790", key: "fld_phone", transport: hub.transport };
    const sent = act({ t: "reply", key: "devbox/navi", text: "The 9:40 one" }, said, link, () => "c1");
    hub.ready();
    await flush();
    expect(calls(hub, "chat_send")).toMatchObject([{ input: { projectRef: { machineId: "devbox", projectId: "navi" }, text: "The 9:40 one", clientRequestId: "c1" } }]);
    hub.answer("chat_send", { message: { messageId: "m9" } });
    await flush();
    hub.answer("push_badge", { badge: 0 });
    expect(await sent).toEqual({ followUp: null, badge: 0 });

    vi.useFakeTimers();
    try {
      const offline = act({ t: "reply", key: "devbox/navi", text: "Hi" }, said, link, () => "c2");
      await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
      expect(await offline).toEqual({ followUp: { title: "Ada", body: "Your reply wasn't sent: The hub can't be reached.", route: { t: "chat", key: "devbox/navi" } } });
    } finally {
      vi.useRealTimers();
    }
  });
});
