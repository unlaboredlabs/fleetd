// Two bots on one GitHub repo share its merge train (W845): its merge mode is one for both, each bot's settings say
// which and with whom, and a pick in either changes it for both. An archived bot shares nothing.
import { expect, test } from "bun:test";
import { archived, mergeModeOf, setArchived, setMergeMode } from "../src/hub/project_lead/store.ts";
import * as repos from "../src/hub/repos/store.ts";
import { events } from "../src/hub/store/events.ts";
import { trainArea } from "../src/hub/train/index.ts";
import { repoVerifying } from "../src/hub/train/verify.ts";
import { type Answer, gh, node, settle } from "./project-kit.ts";
import { AT, key, kit } from "./work-kit.ts";

const person = key("operate", { human: true, person: { personId: "p-ada", name: "Ada" } });
const web = { machineId: "devbox", projectId: "web" };
const shop = { machineId: "devbox", projectId: "shop" };
const docs = { machineId: "devbox", projectId: "docs" };

/** Web and Shop, each with acme/shop in a folder of its own; Docs on another repo. */
async function twoBots(answer?: Answer) {
  const k = kit();
  const n = await node(k, ["repos"], answer);
  for (const [id, title, root] of [["web", "Web", "/home/me/src/shop"], ["shop", "Shop", "/home/me/src/shop-2"], ["docs", "Docs", "/home/me/docs"]] as const) {
    n.event({ type: "project_upserted", projectId: id, title, workspaceRoot: root, updatedAt: AT });
  }
  await settle();
  // Bound as adding a checkout binds it: the repo and base its work lands on, then its own repo.
  for (const [id, repoKey] of [["web", "github.com/acme/shop"], ["shop", "github.com/acme/shop"], ["docs", "github.com/acme/docs"]] as const) {
    k.hub.db.conn
      .query("INSERT INTO work_projects (machine_id, project_id, repo_key, base, updated_ms) VALUES ('devbox', ?1, ?2, 'main', 0)")
      .run(id, repoKey);
    repos.ensureOwn(k.hub.db.conn, { machineId: "devbox", projectId: id }, undefined);
  }
  return k;
}

const settings = async (k: Awaited<ReturnType<typeof twoBots>>, r: typeof web) => (await k.ok(person, "project_settings_get", r)).settings;

test("bots on one repo say they share its merge mode, and a pick in either changes it for both", async () => {
  const k = await twoBots();
  expect((await settings(k, web)).mergeShared).toEqual({ bots: ["Shop"], mode: "test_first" });
  expect((await settings(k, shop)).mergeShared).toEqual({ bots: ["Web"], mode: "test_first" });
  expect((await settings(k, docs)).mergeShared).toBeUndefined();

  await k.ok(person, "project_settings_set", { ...shop, mergeMode: "verify_after" });
  expect([mergeModeOf(k.hub.db.conn, web), mergeModeOf(k.hub.db.conn, shop), mergeModeOf(k.hub.db.conn, docs)]).toEqual(["verify_after", "verify_after", "test_first"]);
  expect((await settings(k, web)).mergeShared).toEqual({ bots: ["Shop"], mode: "verify_after" });
  // Each bot's apps hear of it.
  const said = events(k.hub).page(0, ["project.settings"]).events.filter((e) => (e.data as { mergeMode?: string } | undefined)?.mergeMode === "verify_after");
  expect(said.map((e) => e.projectId).sort()).toEqual(["shop", "web"]);

  await k.ok(person, "project_settings_set", { ...web, mergeMode: "test_first" });
  expect([mergeModeOf(k.hub.db.conn, web), mergeModeOf(k.hub.db.conn, shop)]).toEqual(["test_first", "test_first"]);
});

test("an archived bot on the repo shares nothing and keeps its own mode", async () => {
  const k = await twoBots();
  setArchived(k.hub.db.conn, shop, 1);
  expect(archived(k.hub.db.conn, shop)).toBe(true);
  expect((await settings(k, web)).mergeShared).toBeUndefined();
  await k.ok(person, "project_settings_set", { ...web, mergeMode: "verify_after" });
  expect([mergeModeOf(k.hub.db.conn, web), mergeModeOf(k.hub.db.conn, shop)]).toEqual(["verify_after", "test_first"]);
});

test("modes that differ from before show the one the repo's train goes by, in both bots", async () => {
  const k = await twoBots();
  // From before W845: Shop merges, then verifies, and the repo's train is Shop's.
  setMergeMode(k.hub.db.conn, shop, "verify_after");
  trainArea(k.hub).train.records.ensureTrain("acme/shop", shop, 0);
  expect((await settings(k, web)).mergeShared).toEqual({ bots: ["Shop"], mode: "verify_after" });
  expect((await settings(k, shop)).mergeShared).toEqual({ bots: ["Web"], mode: "verify_after" });
});

test("a bot that takes a repo other bots share takes its train's mode, and its PRs go by that train's mode", async () => {
  // Docs takes acme/shop by path: a free checkout of it, cloned before.
  const k = await twoBots((call) =>
    call.op === "repo_inspect" && call.path === "/home/me/src/shop-old"
      ? { ok: { kind: "repo_facts", exists: true, isGit: true, remote: "git@github.com:acme/shop.git", defaultBranch: "main", workflowFiles: [] } }
      : undefined,
  );
  gh(k, { "repos/acme/shop": { default_branch: "main", allow_squash_merge: true } });
  await k.ok(person, "project_settings_set", { ...web, mergeMode: "verify_after" });
  await k.ok(person, "project_repo_add", { ...docs, path: "/home/me/src/shop-old" });
  expect(mergeModeOf(k.hub.db.conn, docs)).toBe("verify_after");
  expect((await settings(k, docs)).mergeShared).toMatchObject({ mode: "verify_after" });
  // The train goes by the repo's train for every PR on it, whichever bot it is from.
  const { train } = trainArea(k.hub);
  train.records.ensureTrain("acme/shop", web, 0);
  setMergeMode(k.hub.db.conn, shop, "test_first");
  expect(repoVerifying(train, "acme/shop", shop)).toBe(true);
});

test("when the bot a repo's train is bound to is archived, the train moves to a live bot sharing it, so a pick reaches its PRs", async () => {
  const k = await twoBots();
  const { train } = trainArea(k.hub);
  // The repo's train is Shop's; then Shop is archived, and Web, still on the repo, picks how it merges.
  train.records.ensureTrain("acme/shop", shop, 0);
  setArchived(k.hub.db.conn, shop, 1);
  await k.ok(person, "project_settings_set", { ...web, mergeMode: "verify_after" });
  expect(mergeModeOf(k.hub.db.conn, shop)).toBe("test_first");
  // Web's PRs go by Web's pick: the train is Web's now.
  expect(repoVerifying(train, "acme/shop", web)).toBe(true);
  expect(train.records.train("acme/shop")?.projectRef).toEqual(web);
  // A step that names only the train's own bot finds the live one too.
  train.records.rebindTrain("acme/shop", shop);
  expect(train.trainProject("acme/shop", shop)).toEqual(web);
});
