// Task profiles, a project's icon and picture (crates/fleetd/src/hub/projects/profiles.rs, icon.rs, avatar.rs).
import { expect, test } from "bun:test";
import { executors } from "../src/hub/executor/index.ts";
import { link } from "../src/hub/link/server.ts";
import { MODELS_FRESH_MS, MODELS_RETRY_MS, MODELS_WAIT_MS, profiles } from "../src/hub/projects/profiles.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { key, kit, project } from "./work-kit.ts";

/** An owner's device with admin everywhere. */
function owner(k: ReturnType<typeof kit>) {
  k.hub.db.conn.run("INSERT INTO people (person_id, name, role, created_ms) VALUES ('p-own', 'Own', 'owner', 0)");
  return key("admin", { human: true, person: { personId: "p-own", name: "Own" } });
}

test("a fresh hub has its two profiles, the default first, and fleetd's own model list", async () => {
  const k = kit();
  const out = await k.ok(key("read"), "profiles_list", {});
  expect(out.profiles.map((p: { name: string; default: boolean }) => [p.name, p.default])).toEqual([
    ["high", true],
    ["medium", false],
  ]);
  expect(out.modelsFrom).toBe("builtin");
  expect(out.models[0]).toEqual({ id: "claude-opus-5-5", displayName: "Claude Opus 5.5", fast: true });
  expect(out.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
});

test("profiles_list never waits on a Models API that doesn't answer, and asks it again only once its list is old", async () => {
  const k = kit();
  k.hub.db.conn.run(`INSERT INTO claude_accounts (account, data) VALUES ('hub', '{"sealedOn":[{"machineId":"devbox"}]}')`);
  let asked = 0;
  let answer: (models: { id: string; displayName?: string }[]) => void = () => {};
  Object.assign(executors(k.hub), {
    isConnected: (m: string) => m === "devbox",
    call: () => {
      asked += 1;
      return new Promise((resolve) => (answer = (models) => resolve({ kind: "claude_models", models })));
    },
  });
  Object.assign(link(k.hub), { can: () => true });
  const t0 = performance.now();
  const first = await k.ok(key("read"), "profiles_list", {});
  expect(performance.now() - t0).toBeLessThan(MODELS_WAIT_MS + 500);
  expect(first.modelsFrom).toBe("builtin");
  // A second read while the ask runs joins it rather than asking again.
  const second = k.ok(key("read"), "profiles_list", {});
  answer([{ id: "claude-next", displayName: "Claude Next" }]);
  expect((await second).modelsFrom).toBe("api");
  expect(asked).toBe(1);
  const cached = await k.ok(key("read"), "profiles_list", {});
  expect([cached.modelsFrom, cached.models.map((m: { id: string }) => m.id), asked]).toEqual(["api", ["claude-next"], 1]);
  // Past its freshness the API is asked again; a changed key is asked at once.
  k.clock.ms += MODELS_FRESH_MS;
  const again = k.ok(key("read"), "profiles_list", {});
  answer([{ id: "claude-later" }]);
  expect((await again).models.map((m: { id: string }) => m.id)).toEqual(["claude-later"]);
  k.hub.db.conn.run(`UPDATE claude_accounts SET data = '{"sealedOn":[{"machineId":"devbox"}],"v":2}' WHERE account = 'hub'`);
  const rekeyed = k.ok(key("read"), "profiles_list", {});
  answer([{ id: "claude-rekeyed" }]);
  expect((await rekeyed).models.map((m: { id: string }) => m.id)).toEqual(["claude-rekeyed"]);
  expect(asked).toBe(3);
});

test("a model list the endpoint can't give is logged once, with its host and why", async () => {
  const k = kit();
  k.hub.db.conn.run(`INSERT INTO claude_accounts (account, data) VALUES ('hub', '{"endpoint":"http://devbox.example:8317/v1","sealedOn":[{"machineId":"devbox"}]}')`);
  const why = "the Models API at http://devbox.example:8317/v1 didn't answer: Unable to connect";
  Object.assign(executors(k.hub), { isConnected: (m: string) => m === "devbox", call: async () => ({ kind: "claude_models", models: [], error: why }) });
  Object.assign(link(k.hub), { can: () => true });
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
  try {
    expect((await k.ok(key("read"), "profiles_list", {})).modelsFrom).toBe("builtin");
    k.clock.ms += MODELS_RETRY_MS;
    expect((await k.ok(key("read"), "profiles_list", {})).modelsFrom).toBe("builtin");
  } finally {
    console.warn = warn;
  }
  expect(warned).toEqual([`models: the hub's API key listed no models through devbox.example:8317 on devbox, using fleetd's own list: ${why}`]);
});

test("only an owner or admin changes profiles; create, rename, default, lead, delete", async () => {
  const k = kit();
  const own = owner(k);
  const r = { machineId: "devbox", projectId: "app" };
  project(k.hub, r);
  expect(await k.refused(key("admin"), "profile_create", { name: "quick", note: "", model: "claude-haiku-5-5", effort: "low" })).toBe("forbidden");
  expect(await k.refused(own, "profile_create", { name: "x", note: "", model: "gpt-9", effort: "low" })).toBe("invalid");
  expect(await k.refused(own, "profile_create", { name: "x", note: "", model: "claude-haiku-5-5", effort: "low", fast: true })).toBe("invalid");
  const made = await k.ok(own, "profile_create", { name: "quick", note: "", model: "claude-haiku-5-5", effort: "low", lead: true });
  expect(made.profile).toMatchObject({ name: "quick", model: "claude-haiku-5-5", effort: "low", lead: true, default: false });
  expect(made.next).toContain("Leads start on quick (claude-haiku-5-5 at low) from each lead's next start.");
  expect(await k.refused(own, "profile_create", { name: "quick", note: "", model: "claude-haiku-5-5", effort: "low" })).toBe("invalid");
  // A rename carries the tasks not yet ended.
  k.hub.db.conn.run(
    `INSERT INTO tasks (machine_id, project_id, workstream_id, state, data) VALUES ('devbox', 'app', 'W1', 'running', '{"profile":"quick"}')`,
  );
  const renamed = await k.ok(own, "profile_update", { id: made.profile.id, name: "fast-lane" });
  expect(renamed.next).toContain("the ones not yet ended are on fast-lane now");
  expect(k.hub.db.conn.query<{ p: string }, []>("SELECT json_extract(data, '$.profile') AS p FROM tasks").get()?.p).toBe("fast-lane");
  expect(await k.refused(own, "profile_delete", { id: made.profile.id })).toBe("invalid");
  k.hub.db.conn.run("UPDATE tasks SET state = 'done'");
  const s = profiles(k.hub);
  s.setAllowed(r, ["fast-lane", "high"]);
  expect(s.allowed(r)).toEqual(["high", "fast-lane"]);
  expect(s.chosen("fast-lane")).toEqual({ profile: "fast-lane", model: "claude-haiku-5-5", effort: "low", fast: false, helperModel: s.defaultProfile().model });
  expect(s.chosen("gone").profile).toBe("high");
  const deleted = await k.ok(own, "profile_delete", { id: made.profile.id });
  expect(deleted.next).toBe("fast-lane is gone, and no project allows it any more. Leads ran on it, so they start on the default, high, again from their next start.");
  expect(s.allowed(r)).toEqual(["high"]);
  const high = s.defaultProfile();
  expect(await k.refused(own, "profile_delete", { id: high.id })).toBe("invalid");
  expect(await k.refused(own, "profile_update", { id: high.id, default: false })).toBe("invalid");
  // Making another the default moves the mark.
  const medium = s.byName("medium")!;
  await k.ok(own, "profile_update", { id: medium.id, default: true });
  expect(s.defaultProfile().name).toBe("medium");
  // A refused model reads as none until a person sets the model again.
  expect(s.refuse("claude-opus-5-5", "9999", "claude refused it")).toBe(true);
  expect(s.chosen("high").model).toBeUndefined();
  await k.ok(own, "profile_update", { id: high.id, model: "claude-sonnet-5-5" });
  expect(s.byName("high")?.refused).toBeUndefined();
});

test("picking an icon forgets the picture and says so; a project with no picture has none to get", async () => {
  const k = kit();
  const r = { machineId: "devbox", projectId: "app" };
  project(k.hub, r, { title: "App" });
  k.hub.db.conn.run("INSERT INTO project_avatars (machine_id, project_id, avatar, jpeg, set_ms) VALUES ('devbox', 'app', 'abc', x'ffd8', 0)");
  expect(await k.ok(key("read"), "project_avatar_get", r)).toEqual({ avatar: "abc", mime: "image/jpeg", dataB64: "/9g=" });
  const out = await k.ok(key("operate"), "project_icon_set", { ...r, icon: { face: "joy", color: "sun" } });
  expect(out.project.icon).toEqual({ face: "joy", color: "sun" });
  expect(out.project.avatar).toBeUndefined();
  expect(events(k.hub).page(0).events.map((e) => [e.type, e.summary, e.data])).toEqual([
    ["project.settings", "App has a new icon", { icon: { face: "joy", color: "sun" }, avatar: null }],
  ]);
  expect(await k.refused(key("read"), "project_avatar_get", r)).toBe("not_found");
  expect(await k.refused(key("read"), "project_icon_set", { ...r, icon: { face: "joy", color: "sun" } })).toBe("forbidden");
  expect(await k.refused(key("operate"), "project_icon_set", { machineId: "devbox", projectId: "nope", icon: { face: "joy", color: "sun" } })).toBe("not_found");
});

test("a project's settings: memory refresh, setup per repo, Only me's rules, and what env_set refuses", async () => {
  const k = kit();
  const r = { machineId: "devbox", projectId: "app" };
  project(k.hub, r, { title: "App" });
  k.hub.db.conn.run("INSERT INTO machines (machine_id, data) VALUES ('devbox', '{\"machineId\":\"devbox\",\"name\":\"devbox\",\"nodeVersion\":\"1\",\"status\":\"offline\",\"lastSeenAt\":\"x\"}')");
  const got = await k.ok(key("read"), "project_settings_get", r);
  expect(got.settings).toMatchObject({
    machineId: "devbox",
    projectId: "app",
    title: "App",
    memoryRefresh: true,
    env: [],
    setup: { commands: [], timeoutSec: 600, runAnyway: false, inputs: [] },
    worktreesUnknown: "devbox is offline.",
  });
  expect(await k.refused(key("read"), "project_settings_get", { ...r, repo: "web" })).toBe("not_found");

  const off = await k.ok(key("operate"), "project_settings_set", { ...r, memoryRefresh: false });
  expect(off.settings.memoryRefresh).toBe(false);
  expect(off.next).toBe("The nightly memory refresh is off for this project; memory stays as the lead and you write it.");
  const setup = await k.ok(key("operate"), "project_settings_set", { ...r, setup: { commands: ["bun install"] } });
  expect(setup.settings.setup).toEqual({ commands: ["bun install"], timeoutSec: 600, runAnyway: false, inputs: [] });
  expect(setup.next).toBe("New tasks of the project use these settings. devbox's node is too old to run setup commands: update fleetd there.");
  // A repo of the project keeps its own setup; an empty one is the project's.
  k.hub.db.conn.run("INSERT INTO repos (machine_id, project_id, name, checkout_machine_id, checkout_project_id) VALUES ('devbox', 'app', 'web', 'devbox', 'web')");
  await k.ok(key("operate"), "project_settings_set", { ...r, repo: "web", setup: { commands: ["make"] } });
  expect((await k.ok(key("read"), "project_settings_get", { ...r, repo: "web" })).settings).toMatchObject({ repo: "web", setup: { commands: ["make"] } });
  expect((await k.ok(key("read"), "project_settings_get", r)).settings.setup.commands).toEqual(["bun install"]);
  // A rename needs the node.
  expect(await k.refused(key("operate"), "project_settings_set", { ...r, title: "Renamed" })).toBe("machine_offline");

  // Only me: a person's device only; nobody owns it, so only an admin turns it on, and it becomes theirs.
  k.hub.db.conn.run("INSERT INTO people (person_id, name, role, created_ms) VALUES ('p-ada', 'Ada', 'member', 0), ('p-bo', 'Bo', 'admin', 1)");
  const ada = key("operate", { human: true, person: { personId: "p-ada", name: "Ada" } });
  const bo = key("admin", { human: true, person: { personId: "p-bo", name: "Bo" } });
  expect(await k.refused(key("admin"), "project_settings_set", { ...r, onlyMe: true })).toBe("forbidden");
  expect(await k.refused(ada, "project_settings_set", { ...r, onlyMe: true })).toBe("forbidden");
  await k.ok(bo, "project_settings_set", { ...r, onlyMe: true });
  expect(store(k.hub).projectGet(r)).toMatchObject({ onlyMe: true, owner: "p-bo" });
  expect(events(k.hub).page(0).events.at(-1)?.summary).toBe("App: Only me on");

  // env_set: a person's, within the limits, and only with the node there.
  const set = (vars: unknown[]) => ({ ...r, set: vars, remove: [] });
  expect(await k.refused(key("operate"), "project_env_set", set([{ kind: "plain", name: "A", value: "1" }]))).toBe("forbidden");
  const many = Array.from({ length: 101 }, (_, i) => ({ kind: "plain", name: `V${i}`, value: "1" }));
  expect(await k.refused(bo, "project_env_set", set(many))).toBe("invalid");
  const fat = Array.from({ length: 9 }, (_, i) => ({ kind: "plain", name: `F${i}`, value: "x".repeat(60 * 1024) }));
  const res = await k.call(bo, "project_env_set", set(fat));
  expect("error" in res && res.error.kind === "tool" && res.error.error.message).toBe(
    "A project's variables take at most 512 KiB together; these would take 540 KiB.",
  );
  expect(await k.refused(bo, "project_env_set", set([{ kind: "plain", name: "A", value: "1" }]))).toBe("machine_offline");
});
