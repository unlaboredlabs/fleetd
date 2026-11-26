// A bot's safety settings are its workspace's owners' and admins' (W926, api/bot_admin.ts): a member is refused its
// approval mode, who merges and how, its max agents, its card, its automations and deleting it; an admin changes each.
// A lead's automation calls go by the person it acts for, and a member's go-ahead on a card confirms nothing.
import { afterEach, expect, test } from "bun:test";
import { BOT_ADMIN_ONLY } from "../src/hub/api/bot_admin.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { approvals } from "../src/hub/approvals/index.ts";
import { answer } from "../src/hub/automations/calls.ts";
import { automations } from "../src/hub/automations/index.ts";
import { start } from "../src/hub/automations/loops.ts";
import type { LeadCall, LeadCaller } from "../src/hub/leads/seams.ts";
import { approvals as approvalsOf } from "../src/hub/project_lead/checker.ts";
import { notice } from "../src/hub/push/index.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const BEA = { personId: "p-bea", name: "Bea" };
const OLA = { personId: "p-ola", name: "Ola" };
const ADA = { personId: "p-ada", name: "Ada" };
const member = caller("operate", true, BEA);
const admin = caller("admin", true, ADA);
const REFUSED_FIX = "Ask one of them to do it, or to make you an admin in Settings › Workspace › People.";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** A workspace with Ola its owner, Ada an admin and Bea a member, its tools and the bot Shop. */
function setup() {
  const t = testHub();
  cleanup = t.done;
  t.hub.db.conn.run(
    "INSERT INTO people (person_id, name, role, created_ms) VALUES ('p-ola', 'Ola', 'owner', 0), ('p-ada', 'Ada', 'admin', 1), ('p-bea', 'Bea', 'member', 2)",
  );
  const tools = new Registry();
  registerAll(tools);
  const call = async (who: typeof member, tool: string, input: unknown) =>
    (await tools.call(t.hub, who, tool, input)) as { output?: Record<string, unknown>; error?: { error?: { code: string; message: string; fix?: string } } };
  const refusal = async (who: typeof member, tool: string, input: unknown) => {
    const e = (await call(who, tool, input)).error?.error;
    return e && { code: e.code, message: e.message, fix: e.fix };
  };
  const ok = async (who: typeof member, tool: string, input: unknown) => {
    const out = await call(who, tool, input);
    if (out.error) throw new Error(`${tool}: ${JSON.stringify(out.error)}`);
    return out.output!;
  };
  return { ...t, call, refusal, ok };
}

test("a member is refused each of a bot's safety settings, with nothing changed; an admin changes each", async () => {
  const { hub, refusal, ok } = setup();
  const cases: [string, Record<string, unknown>, string][] = [
    ["project_approvals_set", { ...PROJECT, mode: "ask" }, "a bot's approvals"],
    ["project_settings_set", { ...PROJECT, merges: "fleetd" }, "who merges a bot's PRs"],
    ["project_settings_set", { ...PROJECT, mergeMode: "verify_after" }, "who merges a bot's PRs"],
    ["project_settings_set", { ...PROJECT, mergeRules: { itself: ["docs"], person: [] } }, "who merges a bot's PRs"],
    ["project_set", { ...PROJECT, merges: "fleetd" }, "who merges a bot's PRs"],
    ["cap_set", { project: { projectRef: PROJECT, maxAgents: 2 } }, "a bot's max agents"],
    ["project_card_set", { ...PROJECT }, "the card a bot pays with"],
    ["automation_create", { projectRef: PROJECT, name: "Nightly", prompt: "Check the deps.", schedule: { cron: "0 3 * * *", tz: "UTC" }, clientRequestId: "req-n" }, "a bot's automations"],
  ];
  for (const [tool, input, what] of cases) {
    expect(await refusal(member, tool, input)).toEqual({ code: "forbidden", message: `Only the workspace's owners and admins can change ${what}.`, fix: REFUSED_FIX });
  }
  // Nothing moved.
  const shop = store(hub).projectGet(PROJECT)!;
  expect([shop.merges, approvalsOf(hub.db.conn, PROJECT).mode]).toEqual(["people", "checker"]);
  expect(automations(hub).list(PROJECT)).toEqual([]);
  // An admin, and the owner, change each.
  for (const [tool, input] of cases) await ok(tool === "project_set" ? caller("admin", true, OLA) : admin, tool, input);
  const after = store(hub).projectGet(PROJECT)!;
  expect([after.merges, approvalsOf(hub.db.conn, PROJECT).mode]).toEqual(["fleetd", "ask"]);
  expect(automations(hub).list(PROJECT).map((a) => a.name)).toEqual(["Nightly"]);
});

test("a member keeps the rest of a bot: its look, chat tags and Run now", async () => {
  const { ok } = setup();
  await ok(member, "project_settings_set", { ...PROJECT, avatarColor: "teal", chatTags: true });
  const made = await ok(admin, "automation_create", { projectRef: PROJECT, name: "Report", prompt: "Write the report.", clientRequestId: "req-r" });
  const id = (made.automation as { automationId: string }).automationId;
  // Run now starts work, which every member may; changing the automation isn't.
  expect((await ok(member, "automation_run", { automationId: id })).run).toBeDefined();
});

test("a member can't edit, pause, rotate or delete an automation; an admin can", async () => {
  const { refusal, ok } = setup();
  const made = await ok(admin, "automation_create", { projectRef: PROJECT, name: "Report", prompt: "Write the report.", webhook: true, clientRequestId: "req-w" });
  const id = (made.automation as { automationId: string }).automationId;
  for (const [tool, input] of [
    ["automation_update", { automationId: id, name: "Weekly report" }],
    ["automation_pause", { automationId: id, paused: true }],
    ["automation_rotate", { automationId: id }],
    ["automation_delete", { automationId: id }],
  ] as const) {
    expect((await refusal(member, tool, input))?.message).toBe("Only the workspace's owners and admins can change a bot's automations.");
    await ok(admin, tool, input);
  }
});

test("a script's key changes them with an admin grant on the bot's machine, not with operate", async () => {
  const { refusal, ok } = setup();
  expect((await refusal(caller("operate"), "cap_set", { project: { projectRef: PROJECT, maxAgents: 2 } }))?.code).toBe("forbidden");
  await ok(caller("admin"), "cap_set", { project: { projectRef: PROJECT, maxAgents: 2 } });
});

test("a removed admin is a member no more and no less: refused", async () => {
  const { hub, refusal } = setup();
  hub.db.conn.run("UPDATE people SET removed_ms = 5 WHERE person_id = 'p-ada'");
  expect((await refusal(admin, "project_approvals_set", { ...PROJECT, mode: "ask" }))?.code).toBe("forbidden");
});

test("only an admin deletes a bot, and its other people are told who did", async () => {
  const { hub, refusal, ok } = setup();
  // Bea and Ola wrote in its chat; Ada deletes it.
  const message = (seq: number, person: typeof BEA) =>
    hub.db.conn.run("INSERT INTO chat_messages (machine_id, project_id, seq, created_ms, held, data) VALUES (?1, ?2, ?3, ?4, 0, ?5)", [
      PROJECT.machineId,
      PROJECT.projectId,
      seq,
      seq,
      JSON.stringify({ author: "human", text: "hi", person }),
    ]);
  message(1, BEA);
  message(2, OLA);
  message(3, ADA);
  expect(await refusal(member, "project_remove", PROJECT)).toEqual({ code: "forbidden", message: "Only the workspace's owners and admins can delete a bot.", fix: REFUSED_FIX });
  expect(store(hub).projectGet(PROJECT)).toBeDefined();
  // The test workspace has no machine lab-a: deleting forgets the bot.
  await ok(admin, "project_remove", PROJECT);
  expect(store(hub).projectGet(PROJECT)).toBeUndefined();
  const [erased] = events(hub).page(0, ["project.erased"]).events;
  expect([erased!.summary, erased!.attention, erased!.data]).toEqual([
    "Ada deleted the bot Shop",
    "loud",
    { projectId: PROJECT.projectId, title: "Shop", people: ["p-bea", "p-ola"], by: ADA },
  ]);
  // Their phones are told; Ada's isn't.
  expect(notice(hub, erased!)?.people.sort()).toEqual(["p-bea", "p-ola"]);
  expect(notice(hub, erased!)?.payload.body).toBe("Ada deleted the bot Shop");
});

const lead: LeadCaller = { projectRef: PROJECT, by: `lead:${PROJECT.machineId}/${PROJECT.projectId}`, agent: { kind: "lead" } };
const leadCall = (hub: ReturnType<typeof setup>["hub"], op: string, args: Record<string, unknown>) => answer(hub, lead, { op, ...args } as LeadCall);

test("a lead changes automations only for an owner or admin, or when it acts for no one", async () => {
  const { hub, clock } = setup();
  const make = { name: "Nightly", prompt: "Check the deps.", schedule: { cron: "0 3 * * *", tz: "UTC" } };
  // No one asked (an automation's run, a wake): it acts for the owner.
  await leadCall(hub, "automation_create", make);
  // Bea's message started the lead's turn: it acts for her.
  hub.db.conn.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES (?1, ?2, 'th-lead', '', 1)", [
    PROJECT.machineId,
    PROJECT.projectId,
  ]);
  const say = (person: typeof BEA) =>
    hub.db.conn.run("INSERT INTO chat_messages (machine_id, project_id, seq, created_ms, held, data) VALUES (?1, ?2, ?3, ?4, 0, ?5)", [
      PROJECT.machineId,
      PROJECT.projectId,
      clock.ms,
      clock.ms - 1,
      JSON.stringify({ author: "human", text: "make one", person, delivery: "queue" }),
    ]);
  say(BEA);
  await expect(leadCall(hub, "automation_create", make)).rejects.toThrow("Only the workspace's owners and admins can change a bot's automations.");
  const [kept] = automations(hub).list(PROJECT);
  await expect(leadCall(hub, "automation_delete", { automationId: kept!.automationId })).rejects.toThrow("owners and admins");
  // Listing and Run now stay hers.
  expect(((await leadCall(hub, "automation_list", {})).automations as unknown[]).length).toBe(1);
  // Bea's turn ends; Ada's next one is allowed.
  clock.ms += 10;
  events(hub).append({ at: new Date(clock.ms).toISOString(), type: "thread.completed", machineId: PROJECT.machineId, summary: "done", threadId: "th-lead" });
  clock.ms += 10;
  say(ADA);
  await leadCall(hub, "automation_delete", { automationId: kept!.automationId });
  expect(automations(hub).list(PROJECT)).toEqual([]);
});

test("a member's go-ahead on an automation's card leaves it unconfirmed; an admin's confirms it", async () => {
  const { hub } = setup();
  start(hub);
  const made = await leadCall(hub, "automation_create", { name: "Report", prompt: "Write the report.", clientRequestId: "req-r" });
  const a = made.automation as { automationId: string; name: string; prompt: string };
  const card = { automationId: a.automationId, name: a.name, prompt: a.prompt, what: "…" };
  const hooks = approvals(hub).deps.hooks;
  expect(await hooks.automationConfirm(PROJECT, card, "human:Bea's phone", BEA)).toBe(false);
  expect(automations(hub).get(a.automationId)?.confirmed).toBe(false);
  expect(await hooks.automationConfirm(PROJECT, card, "human:Ada's phone", ADA)).toBe(true);
  expect(automations(hub).get(a.automationId)?.confirmed).toBe(true);
});

test("the apps' line for members", () => {
  expect(BOT_ADMIN_ONLY).toBe("Only admins can change this.");
});
