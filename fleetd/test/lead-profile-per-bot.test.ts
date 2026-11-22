// A bot's own lead profile (W825, project_set leadProfile): its lead starts on it, a bot that picked none starts on the
// hub's lead profile, and a change reaches the lead at its next start, or now with leadRestart (mid-turn: once the turn
// ends). The lead's own setup calls carry no such field (D442). Fake ports throughout: no node.
import { afterEach, expect, test } from "bun:test";
import type { Hub } from "../src/hub/api/hub.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { leads } from "../src/hub/leads/index.ts";
import { start } from "../src/hub/leads/loops.ts";
import { leadWiring } from "../src/hub/leads/ports.ts";
import { namedIn } from "../src/hub/projects/people_only.ts";
import { profiles } from "../src/hub/projects/profiles.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { isoMs } from "../src/hub/store/time.ts";
import type { ProfilesListOutput, ProjectSetOutput } from "../src/shared/contracts.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const PERSON = caller("operate", true, { personId: "p_ada", name: "Ada" });

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanups.splice(0).reverse()) done();
});

let threads = 0;

/** A hub with tools to call and a fake launch: the profiles its leads were launched on. */
function hubWithTools() {
  const t = testHub();
  cleanups.push(t.done);
  start(t.hub);
  const launched: string[] = [];
  Object.assign(leadWiring(t.hub).ports, {
    launch: async (_machineId: string, input: { profile: string }) => {
      launched.push(input.profile);
      return `lead-${++threads}`;
    },
    send: async () => false,
  });
  const tools = new Registry();
  registerAll(tools);
  const call = async <T>(tool: string, input: unknown): Promise<T> => {
    const out = await tools.call(t.hub, PERSON, tool, input);
    if ("output" in out) return out.output as T;
    // A call its schema refuses has no ToolError: its message says why.
    throw out.error.kind === "tool" ? out.error.error : new Error(`${out.error.kind}: ${"message" in out.error ? out.error.message : tool}`);
  };
  const s = profiles(t.hub);
  const opus = s.create({ name: "opus", model: "claude-opus-5-5", effort: "max", default: false }, isoMs(t.clock.now()));
  const sonnet = s.create({ name: "sonnet", model: "claude-sonnet-5-5", effort: "high", default: false }, isoMs(t.clock.now()));
  return { ...t, launched, call, opus, sonnet };
}

/** The lead's thread as its node last reported it. */
function threadIs(hub: Hub, status: "idle" | "running") {
  const lead = leads(hub).records.leadGet(PROJECT)!;
  const at = isoMs(hub.clock.now());
  store(hub).threadUpsert({
    thread: { machineId: PROJECT.machineId, threadId: lead.threadId, projectId: PROJECT.projectId, title: "lead", status, headline: "", latestMessageTail: "", lastProgressAt: at, stale: false, asOf: at } as never,
  });
  return lead.threadId;
}

const until = async (what: () => boolean) => {
  for (let i = 0; i < 200 && !what(); i++) await Bun.sleep(5);
  expect(what()).toBe(true);
};

const settle = () => Bun.sleep(30);

const view = (t: ReturnType<typeof hubWithTools>) => t.call<ProfilesListOutput>("profiles_list", { projectRef: PROJECT });

test("a bot with its own lead profile starts its lead on it", async () => {
  const t = hubWithTools();
  const out = await t.call<ProjectSetOutput>("project_set", { ...PROJECT, leadProfile: "opus" });
  expect(out.leadProfile).toBe("opus");
  // What the bot allows stays as it was: the call named no profiles.
  expect(out.profiles).toEqual(profiles(t.hub).allowed(PROJECT));
  expect((await view(t)).leadProfile).toBe("opus");
  await leads(t.hub).start(PROJECT);
  expect(t.launched).toEqual(["opus"]);
  expect(leads(t.hub).records.leadProfileGet(PROJECT)).toBe("opus");
  expect(events(t.hub).page(0).events.find((e) => e.type === "lead.started")?.data).toMatchObject({ profile: "opus" });
});

test("a bot that picks none starts its lead on the hub's lead profile, and follows it", async () => {
  const t = hubWithTools();
  const s = profiles(t.hub);
  s.update(t.sonnet.id, { default: false, lead: true }, isoMs(t.clock.now()));
  await t.call("project_set", { ...PROJECT, leadProfile: "opus" });
  const out = await t.call<ProjectSetOutput>("project_set", { ...PROJECT, leadDefault: true });
  expect(out.leadProfile).toBeUndefined();
  expect((await view(t)).leadProfile).toBeUndefined();
  await leads(t.hub).start(PROJECT);
  expect(t.launched).toEqual(["sonnet"]);
});

test("a profile the bot's lead was on, deleted, puts its lead back on the hub's", async () => {
  const t = hubWithTools();
  await t.call("project_set", { ...PROJECT, leadProfile: "opus" });
  // As profile_delete does it, for an owner or admin.
  profiles(t.hub).delete(t.opus.id);
  expect((await view(t)).leadProfile).toBeUndefined();
  // A new profile that takes the freed id isn't the bot's pick.
  profiles(t.hub).create({ name: "haiku", model: "claude-haiku-5-5", effort: "low", default: false }, isoMs(t.clock.now()));
  await leads(t.hub).start(PROJECT);
  expect(t.launched).toEqual([profiles(t.hub).leadProfile().name]);
});

test("a name no profile has is refused, and the pick stays", async () => {
  const t = hubWithTools();
  await t.call("project_set", { ...PROJECT, leadProfile: "opus" });
  await expect(t.call("project_set", { ...PROJECT, leadProfile: "nope" })).rejects.toMatchObject({ code: "invalid" });
  expect((await view(t)).leadProfile).toBe("opus");
});

test("a change reaches a running lead at its next start; leadRestart starts it on it now", async () => {
  const t = hubWithTools();
  await leads(t.hub).start(PROJECT);
  threadIs(t.hub, "idle");
  const before = leads(t.hub).get(PROJECT)!;
  expect((await view(t)).leadRestart).toBeUndefined();

  await t.call("project_set", { ...PROJECT, leadProfile: "opus" });
  await settle();
  // Not started again by the pick alone: the lead runs on as it was until its next start.
  expect(t.launched.length).toBe(1);
  expect(leads(t.hub).get(PROJECT)?.threadId).toBe(before.threadId);
  expect(leads(t.hub).profileChanged(PROJECT)).toBe(true);
  expect((await view(t)).leadRestart).toBe(true);

  await t.call("project_set", { ...PROJECT, leadRestart: true });
  await until(() => t.launched.length === 2);
  expect(t.launched[1]).toBe("opus");
  const after = leads(t.hub).get(PROJECT)!;
  expect(after.threadId).not.toBe(before.threadId);
  expect(after.sessionGeneration).toBe(before.sessionGeneration + 1);
  expect((await view(t)).leadRestart).toBeUndefined();
});

test("a lead mid-turn asked to restart starts on its new profile once its turn ends", async () => {
  const t = hubWithTools();
  await leads(t.hub).start(PROJECT);
  threadIs(t.hub, "running");
  await t.call("project_set", { ...PROJECT, leadProfile: "sonnet", leadRestart: true });
  await settle();
  expect(t.launched.length).toBe(1);
  // The apps show it waiting on the turn, not Restart lead again.
  expect(await view(t)).toMatchObject({ leadRestarting: true });
  expect((await view(t)).leadRestart).toBeUndefined();
  const threadId = threadIs(t.hub, "idle");
  events(t.hub).append({ at: isoMs(t.clock.now()), type: "thread.completed", machineId: PROJECT.machineId, threadId, summary: "" });
  await until(() => t.launched.length === 2);
  expect(t.launched[1]).toBe("sonnet");
  const after = await view(t);
  expect([after.leadRestart, after.leadRestarting]).toEqual([undefined, undefined]);
});

test("a restart asked of a lead already on its profile starts nothing", async () => {
  const t = hubWithTools();
  await leads(t.hub).start(PROJECT);
  threadIs(t.hub, "idle");
  const out = await t.call<ProjectSetOutput>("project_set", { ...PROJECT, leadRestart: true });
  await settle();
  expect(t.launched.length).toBe(1);
  expect(out.next).toContain("already");
});

test("the lead's own setup calls have no lead profile: it is a person's", () => {
  for (const field of ["leadProfile", "lead_profile", "leadModel"]) expect(namedIn({ [field]: "opus" })?.thing).toBe("agents");
});
