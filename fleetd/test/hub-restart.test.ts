// hub_restart (Settings › Hubs & devices › Restart hub): who may ask, the restart handed to the service manager, and the leads
// whose profile changed since they started: marked as the hub goes down, started again on the current profile by the
// hub that comes up. Fake ports throughout: no service manager, no node.
import { afterEach, expect, test } from "bun:test";
import { Hub } from "../src/hub/api/hub.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { leads } from "../src/hub/leads/index.ts";
import { start } from "../src/hub/leads/loops.ts";
import { leadWiring } from "../src/hub/leads/ports.ts";
import { profiles } from "../src/hub/projects/profiles.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { isoMs } from "../src/hub/store/time.ts";
import { restartPorts } from "../src/hub/update/restart.ts";
import { ToolError } from "../src/shared/errors.ts";
import type { HubRestartOutput } from "../src/shared/contracts.ts";
import type { Service } from "../src/update/service.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const SERVICE: Service = { name: "fleetd-hub.service", unit: "hub" };
const ADMIN = caller("admin", true, { personId: "p_ada", name: "Ada" });

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanups.splice(0).reverse()) done();
});

let threads = 0;

/** Stands fakes in for the executor's launch (after `start`, which wires the real one): the threads it launched. */
function fakeLaunch(hub: Hub, refuse?: () => ToolError | undefined) {
  const launched: string[] = [];
  Object.assign(leadWiring(hub).ports, {
    launch: async (_machineId: string, input: { profile: string }) => {
      const refused = refuse?.();
      if (refused) throw refused;
      launched.push(input.profile);
      return `lead-${++threads}`;
    },
    send: async () => false,
  });
  return launched;
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

/** A hub with a service to restart, whose restarts are counted, and tools to call. */
function hubWithService(t: { hub: Hub }) {
  const tools = new Registry();
  registerAll(tools);
  const restarts: Service[] = [];
  Object.assign(restartPorts(t.hub), { service: () => SERVICE, restart: (s: Service) => void restarts.push(s) });
  const restart = async (as = ADMIN) => {
    const out = await tools.call(t.hub, as, "hub_restart", {});
    return "output" in out ? (out.output as HubRestartOutput) : (out as { error: { error: ToolError } }).error.error;
  };
  return { restarts, restart };
}

/** A hub with a lead on the default profile, its thread idle. */
async function withLead() {
  const t = testHub();
  start(t.hub);
  const launched = fakeLaunch(t.hub);
  await leads(t.hub).start(PROJECT);
  threadIs(t.hub, "idle");
  let live = t.hub;
  cleanups.push(() => {
    if (live === t.hub) return t.done();
    live.shutdown.abort();
    live.db.close();
    t.done();
  });
  /** The hub process that comes up after the restart: the same home, nothing kept in memory. */
  const next = () => {
    live.shutdown.abort();
    live.db.close();
    live = new Hub({ home: t.home, listen: { host: "127.0.0.1", port: 0 } }, HubDb.open(t.home), t.clock);
    return live;
  };
  return { ...t, launched, next, ...hubWithService(t) };
}

/** The lead profile gets another model, as Settings › Hub › Every project › Agents sets it. */
function switchModel(hub: Hub, model = "claude-sonnet-5-5") {
  const s = profiles(hub);
  s.update(s.leadProfile().id, { model, default: false }, isoMs(hub.clock.now()));
}

const until = async (what: () => boolean) => {
  for (let i = 0; i < 200 && !what(); i++) await Bun.sleep(5);
  expect(what()).toBe(true);
};

const settle = () => Bun.sleep(30);

test("only a person's key with Admin on every machine restarts the hub", async () => {
  const t = testHub();
  cleanups.push(t.done);
  const { restarts, restart } = hubWithService(t);
  for (const refused of [caller("operate", true, { personId: "p_bo", name: "Bo" }), caller("admin"), { ...ADMIN, grants: [{ role: "admin" as const, machines: ["lab-a"] }] }]) {
    expect(await restart(refused)).toMatchObject({ code: "forbidden" });
  }
  expect(restarts).toEqual([]);
  expect(await restart()).toEqual({ leads: 0, next: "The hub restarts now: the connection drops for about a second. Agents carry on." });
  expect(restarts).toEqual([SERVICE]);
});

test("a hub that doesn't run as its service, or whose service manager refuses, says so and marks no lead", async () => {
  const t = await withLead();
  switchModel(t.hub);
  Object.assign(restartPorts(t.hub), { service: () => undefined });
  expect(await t.restart()).toMatchObject({ code: "failed", message: "The hub doesn't run as the service `fleetd init` sets up, so it can't restart itself." });
  Object.assign(restartPorts(t.hub), {
    service: () => SERVICE,
    restart: () => {
      throw new Error("systemd-run exited with exit status: 1");
    },
  });
  const refused = await t.restart();
  expect(refused).toMatchObject({ code: "failed", message: "The hub couldn't restart itself: systemd-run exited with exit status: 1." });
  expect((refused as ToolError).fix).toContain("fleetd-hub");
  expect(leads(t.hub).records.leadsSwitchDue()).toEqual([]);
});

test("a lead whose profile changed starts again on it once the hub is back; the hub going down starts nothing", async () => {
  const t = await withLead();
  const before = leads(t.hub).get(PROJECT)!;
  expect(leads(t.hub).profileChanged(PROJECT)).toBe(false);
  switchModel(t.hub);
  expect(leads(t.hub).profileChanged(PROJECT)).toBe(true);
  // Not marked yet: an edited profile alone restarts no lead.
  expect(leads(t.hub).freshDue(PROJECT)).toBe(false);

  const out = (await t.restart()) as HubRestartOutput;
  expect(out.leads).toBe(1);
  expect(out.next).toContain("1 lead starts again on the current lead profile");
  expect(t.restarts).toEqual([SERVICE]);
  expect(leads(t.hub).records.leadsSwitchDue()).toEqual([PROJECT]);
  // The hub that is about to stop leaves the switch to the next one, whatever its lead's thread does meanwhile.
  events(t.hub).append({ at: isoMs(t.clock.now()), type: "thread.completed", machineId: PROJECT.machineId, threadId: before.threadId, summary: "" });
  await settle();
  expect(await leads(t.hub).switchIfDue(PROJECT)).toBeUndefined();
  expect(t.launched.length).toBe(1);

  const hub = t.next();
  // A message to it meanwhile would start the fresh session too.
  expect(leads(hub).freshDue(PROJECT)).toBe(true);
  start(hub);
  const launched = fakeLaunch(hub);
  await until(() => launched.length === 1);
  const after = leads(hub).get(PROJECT)!;
  expect(after.threadId).not.toBe(before.threadId);
  expect(after.sessionGeneration).toBe(before.sessionGeneration + 1);
  expect(leads(hub).records.leadsSwitchDue()).toEqual([]);
  expect(leads(hub).profileChanged(PROJECT)).toBe(false);
  expect(events(hub).page(0).events.filter((e) => e.type === "lead.started").length).toBe(2);
});

test("a lead already on the current profile just resumes", async () => {
  const t = await withLead();
  expect(await t.restart()).toMatchObject({ leads: 0 });
  const before = leads(t.hub).get(PROJECT)!;
  const hub = t.next();
  start(hub);
  const launched = fakeLaunch(hub);
  await settle();
  expect(launched).toEqual([]);
  expect(leads(hub).get(PROJECT)?.threadId).toBe(before.threadId);
});

test("a lead that is mid-turn switches once its turn ends", async () => {
  const t = await withLead();
  switchModel(t.hub);
  threadIs(t.hub, "running");
  expect(await t.restart()).toMatchObject({ leads: 1 });
  const hub = t.next();
  start(hub);
  const launched = fakeLaunch(hub);
  await settle();
  expect(launched).toEqual([]);
  expect(leads(hub).freshDue(PROJECT)).toBe(false);
  const threadId = threadIs(hub, "idle");
  events(hub).append({ at: isoMs(t.clock.now()), type: "thread.completed", machineId: PROJECT.machineId, threadId, summary: "" });
  await until(() => launched.length === 1);
  expect(leads(hub).records.leadsSwitchDue()).toEqual([]);
});

test("a lead whose machine isn't back yet switches when it comes online", async () => {
  const t = await withLead();
  switchModel(t.hub);
  await t.restart();
  const hub = t.next();
  let offline = true;
  const quiet = console.info;
  console.info = () => {};
  cleanups.push(() => void (console.info = quiet));
  start(hub);
  const launched = fakeLaunch(hub, () => (offline ? new ToolError("machine_offline", "Machine lab-a has no live node link.") : undefined));
  await settle();
  expect(launched).toEqual([]);
  expect(leads(hub).records.leadsSwitchDue()).toEqual([PROJECT]);
  offline = false;
  events(hub).append({ at: isoMs(t.clock.now()), type: "machine.online", machineId: PROJECT.machineId, summary: "lab-a is online" });
  await until(() => launched.length === 1);
});

test("a profile put back before the lead got to switch unmarks it", async () => {
  const t = await withLead();
  const was = profiles(t.hub).leadProfile().model;
  switchModel(t.hub);
  threadIs(t.hub, "running");
  await t.restart();
  const hub = t.next();
  switchModel(hub, was);
  expect(await leads(hub).switchIfDue(PROJECT)).toBeUndefined();
  expect(leads(hub).records.leadsSwitchDue()).toEqual([]);
});

test("a lead from before fleetd kept what it was launched with: changed when its profile is another or was edited since", async () => {
  const t = await withLead();
  t.hub.db.conn.run("UPDATE leads SET profile_launched = NULL");
  // The profiles as a hub's migration left them, long before.
  t.hub.db.conn.run("UPDATE profiles SET set_at = '2026-10-01T00:00:00.000Z'");
  expect(leads(t.hub).profileChanged(PROJECT)).toBe(false);
  // Another profile is the leads' now.
  const s = profiles(t.hub);
  const other = s.list().find((p) => !p.default)!;
  s.update(other.id, { default: false, lead: true }, isoMs(t.clock.now() - 60_000));
  expect(leads(t.hub).profileChanged(PROJECT)).toBe(true);
  s.update(other.id, { default: false, lead: false }, isoMs(t.clock.now() - 60_000));
  expect(leads(t.hub).profileChanged(PROJECT)).toBe(false);
  // The same profile, edited after the session started.
  t.clock.ms += 60_000;
  switchModel(t.hub);
  expect(leads(t.hub).profileChanged(PROJECT)).toBe(true);
  expect(await t.restart()).toMatchObject({ leads: 1 });
});
