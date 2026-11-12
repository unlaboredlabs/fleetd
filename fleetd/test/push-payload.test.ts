import { expect, test } from "bun:test";
import type { HubEvent } from "../src/shared/contracts.ts";
import { quietPolicyWith } from "../src/hub/attention/quiet.ts";
import { httpUrl, noticeOf, noticeShape, outcomeOf, relayRequest } from "../src/hub/push/payload.ts";

const ev = (e: Partial<HubEvent> & Pick<HubEvent, "type">): HubEvent => ({ at: "2026-01-02T03:04:05Z", seq: 1, summary: "It happened.", ...e });
const ref = { machineId: "m", projectId: "p" };
const found = { people: ["P1"], quietNow: false, hubUrl: "https://hub.devbox" };

test("an event's shape names what the hub looks up for its notification, and nothing for one nobody is pushed for", () => {
  const lead = (data: object) => ev({ type: "chat.message", data: { author: "lead", state: "final", projectRef: ref, ...data } });
  const message = { messageId: "M1", text: "Done." };
  expect(noticeShape(lead({ message }))).toEqual({ kind: "message", project: ref, message } as never);
  expect(noticeShape(lead({ seq: 7 }))).toEqual({ kind: "message", project: ref, seq: 7 });
  expect(noticeShape(lead({}))).toBeUndefined();
  expect(noticeShape(ev({ type: "chat.message", data: { author: "human", state: "final", projectRef: ref, message } }))).toBeUndefined();
  expect(noticeShape(ev({ type: "workstream.done", ...ref }))).toEqual({ kind: "order", project: ref });
  expect(noticeShape(ev({ type: "workstream.done", ...ref, data: { by: "automation:au_1" } }))).toBeUndefined();
  expect(noticeShape(ev({ type: "workstream.state", data: { state: "stopped" } }))).toEqual({ kind: "order" });
  expect(noticeShape(ev({ type: "request.opened", attention: "loud", ...ref, data: { requestId: "Q1" } }))).toEqual({
    kind: "approval",
    project: ref,
    requestId: "Q1",
  });
  expect(noticeShape(ev({ type: "browser.session", attention: "loud", data: { sessionId: "S1" } }))).toEqual({ kind: "alert", sessionId: "S1" });
  expect(noticeShape(ev({ type: "machine.offline", attention: "loud" }))).toEqual({ kind: "alert" });
  expect(noticeShape(ev({ type: "machine.offline" }))).toBeUndefined();
});

test("a notice is built from its shape and what was found: nobody to tell, or an empty message, sends nothing", () => {
  const order = ev({ type: "workstream.done", ...ref, threadId: "t1" });
  expect(noticeOf(order, { kind: "order", project: ref }, { ...found, title: "Site" })).toEqual({
    payload: { v: 1, kind: "order", title: "Site", body: "It happened.", hub: "https://hub.devbox", ...ref, threadId: "t1", at: order.at },
    people: ["P1"],
  });
  expect(noticeOf(order, { kind: "order" }, { ...found, people: [] })).toBeUndefined();
  expect(noticeOf(order, { kind: "order" }, { ...found, title: "  " })?.payload.title).toBe("fleetd");
  const chat = ev({ type: "chat.message" });
  const shape = { kind: "message", project: ref, seq: 3 } as const;
  expect(noticeOf(chat, shape, found)).toBeUndefined();
  expect(noticeOf(chat, shape, { ...found, message: { messageId: "M1", text: " " } as never })).toBeUndefined();
  expect(noticeOf(chat, shape, { ...found, message: { messageId: "M1", text: "Done." } as never })?.payload).toMatchObject({
    kind: "message",
    body: "Done.",
    messageId: "M1",
    category: "reply",
  });
});

test("an approval collapses per request and is approvable only while open; quiet hours hold all but urgent ones", () => {
  const opened = ev({ type: "request.opened", attention: "loud", summary: "Run it?" });
  const request = { requestId: "Q1", projectRef: ref, state: "open", createdAt: "x", text: "Deploy it.", kind: "gated_run" } as const;
  const gated = { ...request, gated: { argv: ["git", "push"], class: "normal", reason: "r", timeoutSec: 60 } } as never;
  const shape = { kind: "approval", requestId: "Q1" } as const;
  const open = noticeOf(opened, shape, { ...found, request: gated, quietNow: true });
  expect(open?.payload).toMatchObject({ kind: "approval", body: "Deploy it: git push", category: "approve", requestId: "Q1", quiet: true });
  expect(open?.collapse).toMatch(/^[0-9a-f]{16}$/);
  expect(noticeOf(opened, shape, { ...found, request: { ...(gated as object), state: "answered" } as never })?.payload).toMatchObject({ body: "Run it?" });
  expect(noticeOf(opened, shape, { ...found, request: gated, title: "a‮b" })?.payload.category).toBe("review");
  const urgent = noticeOf({ ...opened, attention: "urgent" }, { kind: "alert", sessionId: "S1" }, { ...found, quietNow: true });
  expect(urgent?.payload).toMatchObject({ kind: "alert", urgent: true, sessionId: "S1" });
  expect(urgent?.payload.quiet).toBeUndefined();
  expect(urgent?.collapse).not.toBe(open?.collapse);
});

test("the relay's request carries its key as a bearer, and its answer says what became of the push", () => {
  const push = { platform: "ios", token: "tok", ciphertext: "c" } as const;
  const { url, init } = relayRequest("https://relay.devbox//", "k1", push);
  expect(url).toBe("https://relay.devbox/v1/push");
  expect(init).toEqual({ method: "POST", headers: { "content-type": "application/json", authorization: "Bearer k1" }, body: JSON.stringify(push) });
  expect(relayRequest("https://relay.devbox", undefined, push).init.headers).toEqual({ "content-type": "application/json" });
  const ok = { status: 200, statusText: "OK", ok: true };
  expect(outcomeOf(ok, { status: "sent" })).toEqual({ kind: "sent" });
  expect(outcomeOf({ ...ok, ok: false, status: 500, statusText: "" }, { status: "sent" })).toEqual({ kind: "failed", why: "the relay answered 500" });
  expect(outcomeOf(ok, { status: "dead" })).toEqual({ kind: "dead" });
  expect(outcomeOf({ status: 502, statusText: "Bad Gateway", ok: false }, { status: "failed", error: "apns down" })).toEqual({
    kind: "failed",
    why: "502 Bad Gateway: apns down",
  });
  expect(outcomeOf(ok, undefined)).toEqual({ kind: "failed", why: "the relay answered 200 OK" });
  expect(httpUrl("https://relay.devbox/x")).toBe(true);
  expect(httpUrl("https://relay.devbox/?a=1")).toBe(false);
  expect(httpUrl("ftp://relay.devbox")).toBe(false);
});

test("quiet hours read from the decisions fall back to the zone given when policy.tz names none or a bad one", () => {
  const values = (v: Record<string, string>) => (k: string) => v[k];
  expect(quietPolicyWith(values({}), () => "Asia/Tokyo")).toEqual(["Asia/Tokyo", { start: 23 * 60, end: 8 * 60 }]);
  expect(quietPolicyWith(values({ "policy.tz": "Europe/Berlin", "policy.quiet_hours": "off" }), () => "UTC")).toEqual(["Europe/Berlin", undefined]);
  expect(quietPolicyWith(values({ "policy.tz": "Nowhere/Else" }), () => "UTC")[0]).toBe("UTC");
});
