// A bot's own lead profile (W825, project_set leadProfile): its lead starts on it, a bot that picked none starts on the
// hub's lead profile, and a change reaches the lead at its next start, or now with leadRestart, which stops a turn
// under way as Stop does (a profile switch alone waits for the turn to end). The lead's own setup calls carry no such field (D442). Fake ports throughout: no node.
import { afterEach, expect, test } from "bun:test";
import type { Hub } from "../src/hub/api/hub.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { chat } from "../src/hub/chat/index.ts";
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
const ADMIN = caller("admin", true, { personId: "p_ada", name: "Ada" });

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
  const prompts: string[] = [];
  const interrupted: string[] = [];
  Object.assign(leadWiring(t.hub).ports, {
    launch: async (_machineId: string, input: { profile: string; prompt: string }) => {
      launched.push(input.profile);
      prompts.push(input.prompt);
      return `lead-${++threads}`;
    },
    send: async () => false,
    interrupt: async (thread: { threadId: string }) => void interrupted.push(thread.threadId),
  });
  // A fake node never ends the turn it stops: the restart waits only a moment for it.
  leads(t.hub).settleMs = 10;
  const tools = new Registry();
  registerAll(tools);
  const call = async <T>(tool: string, input: unknown, who = PERSON): Promise<T> => {
    const out = await tools.call(t.hub, who, tool, input);
    if ("output" in out) return out.output as T;
    // A call its schema refuses has no ToolError: its message says why.
    throw out.error.kind === "tool" ? out.error.error : new Error(`${out.error.kind}: ${"message" in out.error ? out.error.message : tool}`);
  };
  const s = profiles(t.hub);
  const opus = s.create({ name: "opus", model: "claude-opus-5-5", effort: "max", default: false }, isoMs(t.clock.now()));
  const sonnet = s.create({ name: "sonnet", model: "claude-sonnet-5-5", effort: "high", default: false }, isoMs(t.clock.now()));
  return { ...t, launched, prompts, interrupted, call, opus, sonnet };
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

test("a bot's own pick switches an idle lead by itself, keeping its chat; picking back leaves it be", async () => {
  const t = hubWithTools();
  await leads(t.hub).start(PROJECT);
  threadIs(t.hub, "idle");
  const before = leads(t.hub).get(PROJECT)!;
  chat(t.hub).add(PROJECT, { author: "human", text: "is the docs page gone?" });
  chat(t.hub).add(PROJECT, { author: "lead", text: "Yes: it moved to /docs/start." });

  const out = await t.call<ProjectSetOutput>("project_set", { ...PROJECT, leadProfile: "opus" });
  expect(out.next).toContain("from its next idle moment");
  // No Restart lead pressed: the idle lead switches to its pick by itself, with the chat it carries on.
  await until(() => t.launched.length === 2);
  expect(t.launched[1]).toBe("opus");
  expect(t.prompts[1]).toContain("## Recent chat");
  expect(t.prompts[1]).toMatch(/^You \([^)]*\): Yes: it moved to \/docs\/start\.$/m);
  const after = leads(t.hub).get(PROJECT)!;
  expect(after.threadId).not.toBe(before.threadId);
  expect(after.sessionGeneration).toBe(before.sessionGeneration + 1);
  expect([(await view(t)).leadRestart, (await view(t)).leadRestarting]).toEqual([undefined, undefined]);
  // A pick of the profile it already runs on switches nothing.
  threadIs(t.hub, "idle");
  await t.call("project_set", { ...PROJECT, leadProfile: "opus" });
  await settle();
  expect(t.launched.length).toBe(2);
});

test("a bot's own pick reaches a lead mid-turn once the turn ends: its next message runs on the new model, with the recap", async () => {
  const t = hubWithTools();
  await leads(t.hub).start(PROJECT);
  const old = threadIs(t.hub, "running");
  chat(t.hub).add(PROJECT, { author: "human", text: "is the docs page gone?" });
  await t.call("project_set", { ...PROJECT, leadProfile: "sonnet" });
  await settle();
  // Never stopped: the turn under way runs on, and the apps show the switch waiting on it.
  expect([t.launched.length, t.interrupted]).toEqual([1, []]);
  expect((await view(t)).leadRestarting).toBe(true);
  chat(t.hub).add(PROJECT, { author: "lead", text: "Yes: it moved to /docs/start." });
  threadIs(t.hub, "idle");
  events(t.hub).append({ at: isoMs(t.clock.now()), type: "thread.completed", machineId: PROJECT.machineId, threadId: old, summary: "" });
  await until(() => t.launched.length === 2);
  expect(t.launched[1]).toBe("sonnet");
  expect(t.prompts[1]).toMatch(/^Human \([^)]*\): is the docs page gone\?$/m);
  expect(t.prompts[1]).toMatch(/^You \([^)]*\): Yes: it moved to \/docs\/start\.$/m);
  // The next message goes to the new session, on the new model.
  const lead = leads(t.hub).get(PROJECT)!;
  expect(lead.threadId).not.toBe(old);
  expect(leads(t.hub).records.leadProfileGet(PROJECT)).toBe("sonnet");
  expect((await view(t)).leadRestarting).toBeUndefined();
});

test("a change of the hub's lead profile switches each lead on it at its next idle moment; a bot's own pick stays", async () => {
  const t = hubWithTools();
  // Ada is the hub's owner: she changes its profiles.
  t.hub.db.conn.run("INSERT INTO people (person_id, name, role, created_ms) VALUES ('p_ada', 'Ada', 'owner', 1)");
  const other = { machineId: PROJECT.machineId, projectId: "p2" };
  store(t.hub).projectsUpsertMany(PROJECT.machineId, [store(t.hub).projectGet(PROJECT)!, { ...store(t.hub).projectGet(PROJECT)!, projectId: other.projectId, title: "Docs" }]);
  // p2 picked its own: the hub's change isn't its lead's.
  await t.call("project_set", { ...other, leadProfile: "opus" });
  await leads(t.hub).start(PROJECT);
  await leads(t.hub).start(other);
  threadIs(t.hub, "idle");
  const p2 = leads(t.hub).records.leadGet(other)!;
  expect(t.launched).toEqual([profiles(t.hub).leadProfile().name, "opus"]);

  // An admin makes sonnet the hub's lead profile: the idle lead on the hub's switches by itself.
  await t.call("profile_update", { id: t.sonnet.id, lead: true }, ADMIN);
  await until(() => t.launched.length === 3);
  expect(t.launched[2]).toBe("sonnet");
  expect(leads(t.hub).records.leadGet(other)?.threadId).toBe(p2.threadId);

  // An edit of the profile it runs on (its effort) reaches it too, at its next idle moment: once its turn ends.
  const old = threadIs(t.hub, "running");
  await t.call("profile_update", { id: t.sonnet.id, effort: "max" }, ADMIN);
  await settle();
  expect(t.launched.length).toBe(3);
  threadIs(t.hub, "idle");
  events(t.hub).append({ at: isoMs(t.clock.now()), type: "thread.completed", machineId: PROJECT.machineId, threadId: old, summary: "" });
  await until(() => t.launched.length === 4);
  expect(t.launched[3]).toBe("sonnet");
  expect(t.interrupted).toEqual([]);

  // A rename runs nothing new: no lead starts again for it.
  threadIs(t.hub, "idle");
  const renamed = await t.call<{ next: string }>("profile_update", { id: t.sonnet.id, name: "sonnet-lead" }, ADMIN);
  expect(renamed.next).not.toContain("leads on it switch");
  await settle();
  expect(t.launched.length).toBe(4);
  // An edit of what it runs says leads on it switch.
  const edited = await t.call<{ next: string }>("profile_update", { id: t.sonnet.id, effort: "high" }, ADMIN);
  expect(edited.next).toContain("leads on it switch at their next idle moment");
  await until(() => t.launched.length === 5);
});

test("a bot's Lead model pick answers at once; the switch goes on in the background", async () => {
  const t = hubWithTools();
  await leads(t.hub).start(PROJECT);
  threadIs(t.hub, "idle");
  // The lead's machine is slow to start the new session.
  let started!: () => void;
  const launch = leadWiring(t.hub).ports.launch;
  leadWiring(t.hub).ports.launch = async (...args) => {
    await new Promise<void>((resolve) => (started = resolve));
    return launch(...args);
  };
  const out = await t.call<ProjectSetOutput>("project_set", { ...PROJECT, leadProfile: "opus" });
  expect(out.leadProfile).toBe("opus");
  expect(t.launched.length).toBe(1);
  await until(() => started !== undefined);
  started();
  await until(() => t.launched.length === 2);
  expect(t.launched[1]).toBe("opus");
});

test("a lead that starts again on a new model says so in the chat in one quiet line; a restart on the same one says nothing", async () => {
  const t = hubWithTools();
  await leads(t.hub).start(PROJECT);
  threadIs(t.hub, "idle");
  const lines = () => chat(t.hub).page(PROJECT, undefined, undefined, 50).messages.filter((m) => m.author === "system").map((m) => m.text);
  await t.call("project_set", { ...PROJECT, leadProfile: "opus", leadRestart: true });
  await until(() => t.launched.length === 2);
  expect(lines()).toEqual(["The lead restarted on opus."]);
  threadIs(t.hub, "idle");
  await t.call("project_set", { ...PROJECT, leadRestart: true });
  await until(() => t.launched.length === 3);
  expect(lines()).toEqual(["The lead restarted on opus."]);
  // One of fleetd's own profiles, named after its effort, is said by its model and effort.
  threadIs(t.hub, "idle");
  await t.call("project_set", { ...PROJECT, leadProfile: "medium", leadRestart: true });
  await until(() => t.launched.length === 4);
  expect(lines()).toEqual(["The lead restarted on opus.", "The lead restarted on Opus 5.5, medium effort."]);
});

test("leadRestart starts a lead on its pick now", async () => {
  const t = hubWithTools();
  await leads(t.hub).start(PROJECT);
  threadIs(t.hub, "idle");
  await t.call("project_set", { ...PROJECT, leadProfile: "opus", leadRestart: true });
  await until(() => t.launched.length === 2);
  expect(t.launched[1]).toBe("opus");
  expect((await view(t)).leadRestart).toBeUndefined();
});

test("a lead mid-turn asked to restart has its turn stopped, as Stop does, and starts on its new profile at once", async () => {
  const t = hubWithTools();
  await leads(t.hub).start(PROJECT);
  const threadId = threadIs(t.hub, "running");
  await t.call("project_set", { ...PROJECT, leadProfile: "sonnet", leadRestart: true });
  await until(() => t.launched.length === 2);
  expect(t.interrupted).toEqual([threadId]);
  expect(t.launched[1]).toBe("sonnet");
  const after = await view(t);
  expect([after.leadRestart, after.leadRestarting]).toEqual([undefined, undefined]);
});

test("a lead whose turn can't be stopped (its machine doesn't answer) stays asked, and starts again once it can", async () => {
  const t = hubWithTools();
  await leads(t.hub).start(PROJECT);
  threadIs(t.hub, "running");
  leadWiring(t.hub).ports.interrupt = async () => {
    throw new Error("machine lab-a has no live node link");
  };
  await t.call("project_set", { ...PROJECT, leadRestart: true });
  await settle();
  expect(t.launched.length).toBe(1);
  // The apps show it waiting, not Restart lead's plain state.
  expect((await view(t)).leadRestarting).toBe(true);
  const threadId = threadIs(t.hub, "idle");
  events(t.hub).append({ at: isoMs(t.clock.now()), type: "thread.completed", machineId: PROJECT.machineId, threadId, summary: "" });
  await until(() => t.launched.length === 2);
});

test("a restart a launch would refuse (out of usage, moved to the cloud) never stops the turn, and says why", async () => {
  const t = hubWithTools();
  await leads(t.hub).start(PROJECT);
  threadIs(t.hub, "running");
  const hooks = leadWiring(t.hub).hooks;
  hooks.usageGate = () => "the login is out of usage until 14:00";
  await expect(t.call("project_set", { ...PROJECT, leadRestart: true })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("out of usage") });
  await settle();
  expect([t.launched.length, t.interrupted]).toEqual([1, []]);
  // Nothing waits marked either: the apps offer Restart lead again, not "Restarts after its turn".
  expect((await view(t)).leadRestarting).toBeUndefined();
  delete hooks.usageGate;
  hooks.moved = () => "this hub's bots moved to fleetd cloud";
  await expect(t.call("project_set", { ...PROJECT, leadRestart: true })).rejects.toMatchObject({ message: expect.stringContaining("moved to fleetd cloud") });
  await settle();
  expect([t.launched.length, t.interrupted]).toEqual([1, []]);
});

test("a profile switch alone waits for a lead's turn to end: nothing stops it", async () => {
  const t = hubWithTools();
  await leads(t.hub).start(PROJECT);
  threadIs(t.hub, "running");
  await t.call("project_set", { ...PROJECT, leadProfile: "sonnet" });
  // As Restart hub marks it (markProfileSwitches), for the switch at the lead's next idle.
  leads(t.hub).records.leadSwitchSet(PROJECT, true);
  await leads(t.hub).switchIfDue(PROJECT);
  await settle();
  expect([t.launched.length, t.interrupted]).toEqual([1, []]);
  const threadId = threadIs(t.hub, "idle");
  events(t.hub).append({ at: isoMs(t.clock.now()), type: "thread.completed", machineId: PROJECT.machineId, threadId, summary: "" });
  await until(() => t.launched.length === 2);
  expect(t.launched[1]).toBe("sonnet");
  expect(t.interrupted).toEqual([]);
});

test("a restart asked of a lead already on its profile starts it again on it: a stuck lead is restarted without a model switch", async () => {
  const t = hubWithTools();
  await leads(t.hub).start(PROJECT);
  threadIs(t.hub, "idle");
  const before = leads(t.hub).get(PROJECT)!;
  const out = await t.call<ProjectSetOutput>("project_set", { ...PROJECT, leadRestart: true });
  await until(() => t.launched.length === 2);
  expect(t.launched[1]).toBe(t.launched[0]);
  const after = leads(t.hub).get(PROJECT)!;
  expect(after.threadId).not.toBe(before.threadId);
  expect(after.sessionGeneration).toBe(before.sessionGeneration + 1);
  expect(out.next).not.toContain("nothing to restart");
  const view_ = await view(t);
  expect([view_.leadRestart, view_.leadRestarting]).toEqual([undefined, undefined]);
  // Asked once, it starts once: the next turn's end starts nothing more.
  const threadId = threadIs(t.hub, "idle");
  events(t.hub).append({ at: isoMs(t.clock.now()), type: "thread.completed", machineId: PROJECT.machineId, threadId, summary: "" });
  await settle();
  expect(t.launched.length).toBe(2);
});

test("a stuck lead on its own profile, asked to restart, has its turn stopped and starts again at once", async () => {
  const t = hubWithTools();
  await leads(t.hub).start(PROJECT);
  const threadId = threadIs(t.hub, "running");
  await t.call("project_set", { ...PROJECT, leadRestart: true });
  await until(() => t.launched.length === 2);
  expect(t.interrupted).toEqual([threadId]);
  expect(t.launched[1]).toBe(t.launched[0]);
  expect((await view(t)).leadRestarting).toBeUndefined();
});

test("a restart asked of a bot with no lead yet starts nothing, and says its first message starts it", async () => {
  const t = hubWithTools();
  const out = await t.call<ProjectSetOutput>("project_set", { ...PROJECT, leadRestart: true });
  await settle();
  expect(t.launched.length).toBe(0);
  expect(out.next).toContain("first message");
});

test("the lead's own setup calls have no lead profile: it is a person's", () => {
  for (const field of ["leadProfile", "lead_profile", "leadModel"]) expect(namedIn({ [field]: "opus" })?.thing).toBe("agents");
});
