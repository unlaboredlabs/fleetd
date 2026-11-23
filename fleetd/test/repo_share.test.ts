// Two bots on one GitHub repo (W845): project_repo_add of a url whose folder is another bot's clones a separate copy
// next to it, and never archives that bot; a folder no bot uses that already holds the repo is used as it is or
// copied, as asked.
import { expect, test } from "bun:test";
import { SAME_REPO_THERE } from "../src/shared/contracts.ts";
import { clones } from "../src/hub/projects/add.ts";
import { setArchived } from "../src/hub/project_lead/store.ts";
import { holder } from "../src/hub/projects/repos.ts";
import * as repos from "../src/hub/repos/store.ts";
import { events } from "../src/hub/store/events.ts";
import type { SessionCall } from "../src/shared/sessions.ts";
import { gh, node, settle } from "./project-kit.ts";
import { AT, key, kit } from "./work-kit.ts";

const operate = key("operate");
const shop = { kind: "repo_facts" as const, exists: true, isGit: true, remote: "git@github.com:acme/shop.git", defaultBranch: "main", workflowFiles: [] };
const other = { kind: "repo_facts" as const, exists: true, isGit: false, workflowFiles: [] };
const none = { kind: "repo_facts" as const, exists: false, isGit: false, workflowFiles: [] };
const web = { machineId: "devbox", projectId: "web" };
const notes = { machineId: "devbox", projectId: "notes" };

/**
 * devbox with the bot Notes, and `taken` folders under /home/me/src: each a checkout of acme/shop, or something else.
 * A clone lands as a checkout of acme/shop.
 */
async function devbox(taken: Record<string, "shop" | "other">) {
  const k = kit();
  clones(k.hub);
  const cloned = new Set<string>();
  const n = await node(k, ["repos", "project_env_copy"], (call: SessionCall) => {
    if (call.op === "repo_inspect") {
      const name = call.path.replace("/home/me/src/", "");
      return { ok: cloned.has(call.path) || taken[name] === "shop" ? shop : taken[name] === "other" ? other : none };
    }
    if (call.op === "repo_clone") {
      cloned.add(call.dest);
      return { ok: shop };
    }
    return undefined;
  });
  n.event({ type: "project_upserted", projectId: "notes", title: "Notes", workspaceRoot: "/home/me/notes", updatedAt: AT });
  gh(k, { "repos/acme/shop": { default_branch: "main", allow_squash_merge: true } });
  await settle();
  return { k, n };
}

test("a repo whose folder is another bot's is cloned into a free folder next to it, and that bot stays as it is", async () => {
  const { k, n } = await devbox({ shop: "shop", "shop-2": "other" });
  n.event({ type: "project_upserted", projectId: "web", title: "Web", workspaceRoot: "/home/me/src/shop", updatedAt: AT });
  await settle();
  // Web is a bot of its own: it has a lead.
  k.hub.db.conn.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'web', 'th-web', '2026-11-01T00:00:00Z', 1)");
  // The old "use the checkout there" asks for it: still a separate copy, never the other bot archived.
  const out = await k.ok(operate, "project_repo_add", { ...notes, url: "acme/shop", useExisting: true });
  expect(out.path).toBe("/home/me/src/shop-3");
  expect(out.next).toStartWith("/home/me/src/shop is the bot Web's, so this is a separate copy. Cloning into /home/me/src/shop-3 on devbox.");
  expect(n.calls.filter((c) => c.op === "repo_clone").map((c) => (c as { dest: string }).dest)).toEqual(["/home/me/src/shop-3"]);
  await settle();
  await settle();
  const got = repos.of(k.hub.db.conn, notes);
  expect(got.map((r) => [r.name, r.path, r.repoKey])).toEqual([["shop", "/home/me/src/shop-3", "github.com/acme/shop"]]);
  expect(holder(k.hub, web)).toBeUndefined();
  expect(events(k.hub).page(0, ["project.added"]).events.at(-1)?.data).toMatchObject({ addId: out.addId, path: "/home/me/src/shop-3" });
  // Both bots are on the repo, each with a checkout of its own: the merge train and landings see both.
  expect(repos.withKey(k.hub.db.conn, "github.com/acme/shop").map((r) => r.projectId).sort()).toContain("notes");
  // Asked again, the bot has it already.
  const again = await k.call(operate, "project_repo_add", { ...notes, url: "https://github.com/acme/shop" });
  expect(again).toMatchObject({ error: { error: { code: "invalid", message: "The bot already has acme/shop: its repo shop." } } });
});

test("a dest that is another bot's folder is refused by name, and copy puts it next to it", async () => {
  const { k, n } = await devbox({ shop: "shop" });
  n.event({ type: "project_upserted", projectId: "web", title: "Web", workspaceRoot: "/home/me/src/shop", updatedAt: AT });
  await settle();
  k.hub.db.conn.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'web', 'th-web', '2026-11-01T00:00:00Z', 1)");
  const refused = await k.call(operate, "project_repo_add", { ...notes, url: "acme/shop", dest: "/home/me/src/shop" });
  expect(refused).toMatchObject({ error: { error: { code: "invalid", message: "/home/me/src/shop on devbox is the bot Web's folder" } } });
  const out = await k.ok(operate, "project_repo_add", { ...notes, url: "acme/shop", dest: "/home/me/src/shop", copy: true });
  expect(out.path).toBe("/home/me/src/shop-2");
  expect(holder(k.hub, web)).toBeUndefined();
});

test("a folder no bot uses that holds the repo is used as it is, or copied, as asked", async () => {
  const { k } = await devbox({ shop: "shop" });
  const asked = await k.call(operate, "project_repo_add", { ...notes, url: "acme/shop" });
  expect(asked).toMatchObject({ error: { error: { code: "invalid", reason: SAME_REPO_THERE, message: "devbox already has a copy of acme/shop at /home/me/src/shop" } } });
  expect(await k.refused(operate, "project_repo_add", { ...notes, url: "acme/shop", useExisting: true, copy: true })).toBe("invalid");
  expect(await k.refused(operate, "project_repo_add", { ...notes, path: "/home/me/src/shop", copy: true })).toBe("invalid");
  const used = await k.ok(operate, "project_repo_add", { ...notes, url: "acme/shop", useExisting: true });
  expect(used.repo).toMatchObject({ name: "shop", path: "/home/me/src/shop", repoKey: "github.com/acme/shop" });
  expect(used.archived).toBeUndefined();

  const second = await devbox({ shop: "shop" });
  const copied = await second.k.ok(operate, "project_repo_add", { ...notes, url: "acme/shop", copy: true });
  expect(copied.path).toBe("/home/me/src/shop-2");
  expect(copied.next).toStartWith("/home/me/src/shop is taken, so this is a separate copy.");
});

test("another bot's folder given as a path is copied beside it too: adding a repo never archives a bot", async () => {
  const { k, n } = await devbox({ shop: "shop" });
  n.event({ type: "project_upserted", projectId: "web", title: "Web", workspaceRoot: "/home/me/src/shop", updatedAt: AT });
  await settle();
  k.hub.db.conn.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'web', 'th-web', '2026-11-01T00:00:00Z', 1)");
  const out = await k.ok(operate, "project_repo_add", { ...notes, path: "/home/me/src/shop/" });
  expect(out).toMatchObject({ path: "/home/me/src/shop-2", separateFrom: "/home/me/src/shop" });
  expect(out.archived).toBeUndefined();
  await settle();
  await settle();
  expect(repos.of(k.hub.db.conn, notes).map((r) => r.path)).toEqual(["/home/me/src/shop-2"]);
  expect(holder(k.hub, web)).toBeUndefined();
});

test("a default folder holding something else is cloned beside, and with every folder beside it taken the add says so plainly", async () => {
  const { k } = await devbox({ shop: "other" });
  const out = await k.ok(operate, "project_repo_add", { ...notes, url: "acme/shop" });
  expect(out).toMatchObject({ path: "/home/me/src/shop-2", separateFrom: "/home/me/src/shop" });
  const taken = Object.fromEntries(["shop", ...Array.from({ length: 19 }, (_, i) => `shop-${i + 2}`)].map((f) => [f, "other" as const]));
  const full = await devbox(taken);
  const refused = await full.k.call(operate, "project_repo_add", { ...notes, url: "acme/shop" });
  expect(refused).toMatchObject({ error: { error: { message: "/home/me/src/shop-2 to /home/me/src/shop-20 on devbox are all taken", fix: "Move some of those folders away, then add it again" } } });
});

test("a live bot whose lead never ran and has no chat keeps its folder and its environment; an archived bot's folder is added as it is", async () => {
  const { k, n } = await devbox({ shop: "shop" });
  n.event({ type: "project_upserted", projectId: "web", title: "Web", workspaceRoot: "/home/me/src/shop", updatedAt: AT });
  await settle();
  // No lead row, no chat: still a bot, so a separate copy, and nothing of Notes' goes into Web's folder.
  const out = await k.ok(operate, "project_repo_add", { ...notes, path: "/home/me/src/shop" });
  expect(out).toMatchObject({ path: "/home/me/src/shop-2", separateFrom: "/home/me/src/shop" });
  await settle();
  await settle();
  expect(n.calls.filter((c) => c.op === "project_env_copy").map((c) => (c as { to: string }).to)).not.toContain("web");
  expect(holder(k.hub, web)).toBeUndefined();
  // Archived, it is no live bot's: its folder is added as it is.
  const second = await devbox({ shop: "shop" });
  second.n.event({ type: "project_upserted", projectId: "web", title: "Web", workspaceRoot: "/home/me/src/shop", updatedAt: AT });
  await settle();
  setArchived(second.k.hub.db.conn, web, 1);
  const used = await second.k.ok(operate, "project_repo_add", { ...notes, path: "/home/me/src/shop" });
  expect(used.repo).toMatchObject({ path: "/home/me/src/shop", checkout: web });
});
