// Task profiles, a project's icon and picture (crates/fleetd/src/hub/projects/profiles.rs, icon.rs, avatar.rs).
import { expect, test } from "bun:test";
import { profiles } from "../src/hub/projects/profiles.ts";
import { events } from "../src/hub/store/events.ts";
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
