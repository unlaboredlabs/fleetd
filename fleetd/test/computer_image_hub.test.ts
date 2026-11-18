// A bot's computer image on the hub (src/hub/projects/settings.ts): its settings show each repo's image as its
// checkout's node says it, Rebuild asks that node to build it again, a setup change has it build, and the node's word
// that an image changed reaches every app showing a bot that holds the checkout.
import { expect, test } from "bun:test";
import type { ComputerImage } from "../src/shared/contracts.ts";
import { executors } from "../src/hub/executor/index.ts";
import { link } from "../src/hub/link/server.ts";
import { imageChanged } from "../src/hub/projects/settings.ts";
import { events } from "../src/hub/store/events.ts";
import { key, kit, project } from "./work-kit.ts";

function bot() {
  const k = kit();
  const r = { machineId: "devbox", projectId: "app" };
  project(k.hub, r, { title: "App" });
  k.hub.db.conn.run("INSERT INTO machines (machine_id, data) VALUES ('devbox', '{\"machineId\":\"devbox\",\"name\":\"devbox\",\"nodeVersion\":\"1\",\"status\":\"online\",\"lastSeenAt\":\"x\"}')");
  k.hub.db.conn.run("INSERT INTO repos (machine_id, project_id, name, checkout_machine_id, checkout_project_id) VALUES ('devbox', 'app', 'app', 'devbox', 'app')");
  k.hub.db.conn.run("INSERT INTO repos (machine_id, project_id, name, checkout_machine_id, checkout_project_id, base) VALUES ('devbox', 'app', 'web', 'devbox', 'web', 'release')");
  const calls: Record<string, unknown>[] = [];
  let image: ComputerImage = { state: "ready", builtAt: "2026-11-18T10:00:00.000Z", bytes: 1_100_000_000, where: "vm" };
  Object.assign(executors(k.hub), {
    isConnected: (m: string) => m === "devbox",
    call: async (_m: string, _op: string, call: Record<string, unknown>) => {
      calls.push(call);
      if (call.op === "project_image") return { kind: "project_image", image: call.rebuild ? { ...image, state: "building", startedAt: "2026-11-18T11:00:00.000Z" } : image };
      if (call.op === "project_worktrees") return { kind: "project_worktrees", dir: "/w", worktrees: [] };
      throw new Error(`unexpected ${String(call.op)}`);
    },
  });
  Object.assign(link(k.hub), { can: () => true });
  return { k, r, calls, setImage: (i: ComputerImage) => void (image = i) };
}

test("a bot's settings show each repo's computer image, as its checkout's node has it", async () => {
  const { k, r, calls } = bot();
  // Setting a repo's setup asks its checkout's node for the image, which builds the one due.
  await k.ok(key("operate"), "project_settings_set", { ...r, repo: "web", setup: { commands: ["curl https://sh.rustup.rs | sh -s -- -y"], inputs: ["rust-toolchain.toml"] } });
  const asked = calls.filter((c) => c.op === "project_image").at(-1)!;
  // With the repo's base branch, which its image is built from.
  expect(asked).toEqual({ op: "project_image", projectId: "web", setup: { commands: ["curl https://sh.rustup.rs | sh -s -- -y"], inputs: ["rust-toolchain.toml"] }, base: "release" });
  const got = await k.ok(key("read"), "project_settings_get", { ...r, repo: "web" });
  expect(got.settings.image).toEqual({ state: "ready", builtAt: "2026-11-18T10:00:00.000Z", bytes: 1_100_000_000, where: "vm" });
});

test("Rebuild builds a repo's image again on its checkout's node, and is refused without setup commands", async () => {
  const { k, r, calls } = bot();
  expect(await k.refused(key("operate"), "project_image_rebuild", r)).toBe("invalid");
  await k.ok(key("operate"), "project_settings_set", { ...r, setup: { commands: ["bun install"] } });
  expect(await k.refused(key("read"), "project_image_rebuild", r)).toBe("forbidden");
  const out = await k.ok(key("operate"), "project_image_rebuild", r);
  expect(out.image).toMatchObject({ state: "building", startedAt: "2026-11-18T11:00:00.000Z", builtAt: "2026-11-18T10:00:00.000Z" });
  expect(out.next).toContain("new agents start from it");
  expect(calls.at(-1)).toEqual({ op: "project_image", projectId: "app", setup: { commands: ["bun install"], inputs: [] }, rebuild: true });
  // Its node offline: refused in plain words.
  Object.assign(executors(k.hub), { isConnected: () => false });
  expect(await k.refused(key("operate"), "project_image_rebuild", r)).toBe("machine_offline");
});

test("a checkout's image changing tells the apps of every bot holding it", () => {
  const { k } = bot();
  const before = events(k.hub).page(0).events.length;
  imageChanged(k.hub, "devbox", "web");
  imageChanged(k.hub, "devbox", "app");
  const now = events(k.hub).page(0).events.slice(before).map((e) => [e.type, e.projectId, e.data]);
  expect(now).toEqual([
    ["project.settings", "app", { image: true, repo: "web" }],
    ["project.settings", "app", { image: true }],
  ]);
});
