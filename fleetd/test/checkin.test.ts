// The daily check-in (src/hub/watchers/checkin.ts): off until a person switches it on, quiet on a day with nothing to
// offer, and an offer with buttons that starts nothing until the person taps one. Sessions are fakes on a fake clock.
import { afterEach, expect, test } from "bun:test";
import type { Hub } from "../src/hub/api/hub.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { answer } from "../src/hub/automations/calls.ts";
import { automations, type NewAutomation } from "../src/hub/automations/index.ts";
import { registerLeadCalls } from "../src/hub/chat/calls.ts";
import { intake } from "../src/hub/leads/workstreams.ts";
import { start } from "../src/hub/leads/loops.ts";
import { leadWiring } from "../src/hub/leads/ports.ts";
import type { LeadCall, LeadCaller } from "../src/hub/leads/seams.ts";
import { type SendOpts, WriteQueue } from "../src/hub/queue/index.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { events } from "../src/hub/store/events.ts";
import { isoMs } from "../src/hub/store/time.ts";
import {
  CHECKIN_WATCH,
  checkInEvidence,
  NOT_NOW,
  offerOf,
  offerOptions,
  offerText,
  promises,
  STALL_MS,
  watchers,
  type WatcherPorts,
} from "../src/hub/watchers/index.ts";
import type { ChatMessage } from "../src/shared/contracts.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const HOUR = 3_600_000;
const START = Date.parse("2026-11-24T08:00:00Z");

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const OFFER = '{"text": "One thing I can pick up: the login fix stalled on Tuesday. Want me to?", "options": ["Finish the login fix"]}';

function setup() {
  const t = testHub(START);
  cleanup = t.done;
  const launched: { prompt: string; onlyTools?: string[] }[] = [];
  const said = new Map<string, string>();
  const ports: WatcherPorts = {
    launch: async (_m, input, options) => {
      launched.push({ prompt: input.prompt, ...(options.onlyTools ? { onlyTools: options.onlyTools } : {}) });
      return `th-${launched.length}`;
    },
    stop: async () => {},
    text: async (thread) => said.get(thread.threadId),
    cost: async () => 0.004,
    github: async () => ({ ok: false, status: 404, message: "Not Found" }),
  };
  watchers(t.hub).port = ports;
  return { ...t, launched, said };
}

const checkIn: NewAutomation = { projectRef: PROJECT, name: "", prompt: "", schedule: { tz: "Europe/Berlin" }, webhook: false, by: "human", confirmed: true, watch: CHECKIN_WATCH };

async function settle(hub: Hub): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Bun.sleep(2);
    await automations(hub).settled();
    await watchers(hub).settled();
  }
}

const messages = (hub: Hub) =>
  hub.db
    .all<{ data: string }>("SELECT data FROM chat_messages WHERE machine_id = ? AND project_id = ? ORDER BY seq", [PROJECT.machineId, PROJECT.projectId])
    .map((r) => JSON.parse(r.data) as ChatMessage);

const orders = (hub: Hub) => hub.db.all<{ n: number }>("SELECT n FROM workstreams").length;

const ended = (hub: Hub, threadId: string) =>
  events(hub).append({ at: isoMs(hub.clock.now()), type: "thread.completed", machineId: PROJECT.machineId, threadId, summary: "ended", data: { threadId } });

/** An order opened now, whose work then stops moving. */
const openOrder = (hub: Hub, text = "Fix the login page") =>
  intake(hub).intake({ projectRef: PROJECT, text, clientRequestId: `o-${text}`, channel: "chat", by: "human" }).workstreamId;

test("a bot has no check-in until a person switches it on, and the lead can't switch it on", async () => {
  const { hub, clock, launched } = setup();
  openOrder(hub);
  clock.ms += 3 * STALL_MS;
  expect(automations(hub).list(PROJECT).filter((a) => a.watch?.kind === "checkin")).toEqual([]);
  automations(hub).signal();
  await settle(hub);
  expect(launched).toEqual([]);
  expect(messages(hub)).toEqual([]);

  const lead: LeadCaller = { projectRef: PROJECT, by: `lead:${PROJECT.machineId}/${PROJECT.projectId}` } as LeadCaller;
  const call = { op: "automation_create", name: "Daily check-in", prompt: "x", watch: CHECKIN_WATCH } as unknown as LeadCall;
  await expect(answer(hub, lead, call)).rejects.toThrow("Only the person switches the daily check-in on.");

  // Switched on by the person: daily at 09:00 in their zone, one per bot.
  const [a] = automations(hub).create(checkIn);
  expect([a.name, a.schedule?.cron, a.schedule?.tz, a.webhook]).toEqual(["Daily check-in", "0 9 * * *", "Europe/Berlin", false]);
  expect(() => automations(hub).create(checkIn)).toThrow("already has a Daily check-in watcher");
  expect(() => automations(hub).update(a.automationId, { name: "Other" }, "human")).toThrow("is a preset");
  // The lead may pause it for the person, never resume or change it.
  await expect(answer(hub, lead, { op: "automation_update", automationId: a.automationId, paused: false } as unknown as LeadCall)).rejects.toThrow(
    "Only the person changes the daily check-in.",
  );
  await answer(hub, lead, { op: "automation_update", automationId: a.automationId, paused: true } as unknown as LeadCall);
  expect(automations(hub).get(a.automationId)?.paused).toBe(true);
});

test("a quiet day starts no session and posts nothing", async () => {
  const { hub, launched } = setup();
  // An order still moving is not stalled, and a promise-free chat promises nothing.
  openOrder(hub);
  const [a] = automations(hub).create(checkIn);
  const run = await automations(hub).run(a.automationId, { kind: "schedule", dueMs: hub.clock.now() });
  await settle(hub);
  expect(run.state).toBe("running");
  expect(automations(hub).runs(a.automationId, 1)[0]).toMatchObject({ state: "done", why: "Nothing waits today.", costUsd: 0 });
  expect(launched).toEqual([]);
  expect(messages(hub)).toEqual([]);
  expect(orders(hub)).toBe(1);
});

test("a stalled order makes one offer with buttons, which starts no order; the same day again offers nothing", async () => {
  const { hub, clock, launched, said } = setup();
  openOrder(hub);
  clock.ms += STALL_MS + HOUR;
  watchers(hub).start();
  const [a] = automations(hub).create(checkIn);
  await automations(hub).run(a.automationId, { kind: "schedule", dueMs: clock.now() });
  await settle(hub);
  expect(launched.length).toBe(1);
  // No tools: it only offers.
  expect(launched[0]?.onlyTools).toEqual([]);
  expect(launched[0]?.prompt).toContain('"Fix the login page", last changed 2026-11-24 08:00 UTC, 25 h ago');
  expect(launched[0]?.prompt).toContain("start nothing: you only offer");

  said.set("th-1", `Looked at it.\n${OFFER}`);
  ended(hub, "th-1");
  await settle(hub);
  const posted = messages(hub);
  expect(posted.length).toBe(1);
  const m = posted[0]!;
  expect(m.author).toBe("lead");
  expect(m.parts?.[0]?.block).toEqual({
    v: 1,
    kind: "ask",
    question: "One thing I can pick up: the login fix stalled on Tuesday. Want me to?",
    options: ["Finish the login fix", NOT_NOW],
  });
  expect(automations(hub).runs(a.automationId, 1)[0]).toMatchObject({ state: "done", said: "One thing I can pick up: the login fix stalled on Tuesday. Want me to?", costUsd: 0.004 });
  // Only the order that was there: the offer opened none.
  expect(orders(hub)).toBe(1);

  // The same stalled order the next day: no session, nothing posted again.
  clock.ms += 24 * HOUR;
  await automations(hub).run(a.automationId, { kind: "schedule", dueMs: clock.now() });
  await settle(hub);
  expect(launched.length).toBe(1);
  expect(automations(hub).runs(a.automationId, 1)[0]).toMatchObject({ state: "done", why: "Nothing new since the last check-in." });
  expect(messages(hub).length).toBe(1);
});

test("an OK answer posts nothing, and one that isn't an offer fails and posts nothing", async () => {
  const { hub, clock, said } = setup();
  openOrder(hub);
  clock.ms += STALL_MS + HOUR;
  watchers(hub).start();
  const [a] = automations(hub).create(checkIn);
  await automations(hub).run(a.automationId, { kind: "manual", by: "human" });
  await settle(hub);
  said.set("th-1", "Nothing worth their time.\nOK");
  ended(hub, "th-1");
  await settle(hub);
  expect(automations(hub).runs(a.automationId, 1)[0]).toMatchObject({ state: "done", why: "Nothing worth offering today." });
  expect(messages(hub)).toEqual([]);

  openOrder(hub, "Add dark mode");
  clock.ms += STALL_MS + HOUR;
  await automations(hub).run(a.automationId, { kind: "manual", by: "human" });
  await settle(hub);
  said.set("th-2", '{"text": "See https://evil.example now?", "options": ["Open it"]}');
  ended(hub, "th-2");
  await settle(hub);
  expect(automations(hub).runs(a.automationId, 1)[0]).toMatchObject({ state: "failed" });
  expect(automations(hub).runs(a.automationId, 1)[0]?.why).toContain("Its offer couldn't show");
  expect(messages(hub)).toEqual([]);
});

test("a tap on an offer's button is the person's message to the lead, answering that offer", async () => {
  const t = testHub(START);
  cleanup = t.done;
  const launches: string[] = [];
  t.hub.area(
    "write_queue",
    (h) =>
      new WriteQueue(h, {
        isConnected: () => true,
        awaitLive: async () => {},
        sendWith: async (_thread, _text: string, _crid: string, _opts: SendOpts) => ({}),
      }),
  );
  start(t.hub, {});
  Object.assign(leadWiring(t.hub).ports, {
    launch: async (_m: string, input: { prompt: string }) => {
      launches.push(input.prompt);
      return `lead-${launches.length}`;
    },
  });
  registerLeadCalls(t.hub);
  const tools = new Registry();
  registerAll(tools);
  const send = async (text: string, id: string) =>
    ((await tools.call(t.hub, caller("operate", true), "chat_send", { projectRef: PROJECT, text, clientRequestId: id })) as { output: { message: ChatMessage } }).output.message;

  const { chat } = await import("../src/hub/chat/index.ts");
  const offer = chat(t.hub).add(PROJECT, { author: "lead", text: offerText({ text: "The login fix stalled. Want me to finish it?", options: ["Finish the login fix"] }), source: "checkin:ar_1" }).message;
  // Nothing started by the offer itself.
  expect(launches).toEqual([]);
  const yes = await send("Finish the login fix", "c1");
  expect(yes.replyTo).toEqual({ messageId: offer.messageId, part: 0 });
  expect(launches.length).toBe(1);
  expect(launches[0]).toContain("The login fix stalled. Want me to finish it?");
  // Words that aren't a button, or a second tap after the first, answer nothing.
  const other = await send("Finish the login fix", "c2");
  expect(other.replyTo).toBeUndefined();
});

test("the check-in's pure rules: evidence, promises, and the session's answer", () => {
  const now = Date.parse("2026-11-26T09:00:00Z");
  expect(checkInEvidence({ stalled: [], waiting: [], promised: [], closed: ["Old"] }, now)).toBeUndefined();
  const e = checkInEvidence(
    {
      stalled: [{ id: "W1", title: "Fix login", since: "2026-11-24T09:00:00Z" }],
      waiting: [{ id: "Q2", kind: "approval", text: "fly deploy", at: "2026-11-26T07:00:00Z" }],
      promised: [{ id: "m3", text: "I'll check back tomorrow on the pricing page.", at: "2026-11-25T18:00:00Z" }],
      closed: [],
    },
    now,
  )!;
  expect(e.text).toContain('- an approval: "fly deploy", asked 2026-11-26 07:00 UTC, 2 h ago');
  expect(e.text).not.toContain("W1");
  expect(e.key).toBe("p:m3\ns:W1\nw:Q2");
  expect(promises("I'll check back on Friday")).toBe(true);
  expect(promises("Starting 3 agents now.")).toBe(false);
  expect(offerOf("**OK**")).toBeUndefined();
  expect(offerOf("nope")).toBe("Its answer was neither OK nor an offer.");
  expect(offerOf('{"text": "Two things. Want me to?", "options": ["Do both", "Not now", "do both", "Fix login", "Deploy", "Extra"]}')).toEqual({
    text: "Two things. Want me to?",
    options: ["Do both", "Fix login", "Deploy"],
  });
  expect(offerOptions(offerText({ text: "Want me to?", options: ["Yes"] }))).toEqual(["Yes", NOT_NOW]);
  expect(offerOptions("plain words")).toBeUndefined();
});
