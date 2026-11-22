// Who merges a bot's PRs and its risk rules outside the train: the rules' globs, named kinds and decision
// (train/merge_rules.ts); the migration that keeps every bot a hub already has on fleetd merging while a new one
// defaults to people; and project_settings_set / project_set, a person's pick only.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/gen/migrations.ts";
import { mergesFlag } from "../src/cli/project.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { mergesOf, riskRulesOf } from "../src/hub/project_lead/store.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { migrate } from "../src/hub/store/migrations.ts";
import { store } from "../src/hub/store/hub_store.ts";
import {
  decide,
  DEFAULT_RISK_RULES,
  formattingOnly,
  globRegex,
  lockfileBumpsOnly,
  matches,
  type MergeFile,
  rulesProblems,
} from "../src/hub/train/merge_rules.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const file = (path: string, patch?: string, status = "modified"): MergeFile => ({ path, status, ...(patch === undefined ? {} : { patch }) });

test("a glob: ** spans folders, * stays in one name, one with no slash matches a name anywhere, case folded", () => {
  expect(globRegex("docs/**").test("docs/a/b.md")).toBe(true);
  expect(globRegex("docs/*.md").test("docs/a/b.md")).toBe(false);
  expect(globRegex("*.sql").test("db/migrations/1.sql")).toBe(true);
  expect(globRegex("src/**/*.test.ts").test("src/x.test.ts")).toBe(true);
  expect(globRegex("*.{md,mdx}").test("README.MDX")).toBe(true);
  expect(globRegex("Dockerfile*").test("deploy/Dockerfile.prod")).toBe(true);
  expect(globRegex("a/?.txt").test("a/bc.txt")).toBe(false);
  expect(() => globRegex("{a,b")).toThrow();
});

test("the named kinds: docs and tests by path, the person kinds by path, a rename judged on both its names", () => {
  expect(matches("docs", file("docs/guide.md"))).toBe(true);
  expect(matches("docs", file("requirements.txt"))).toBe(false);
  // Docs are docs folders and READMEs, never Markdown that steers agents: their instructions, skills and prompts.
  expect(matches("docs", file("docs/site/src/content/docs/merge-train.md"))).toBe(true);
  expect(matches("docs", file("app/mobile/README.md"))).toBe(true);
  expect(matches("docs", file("notes/plan.md"))).toBe(false);
  for (const steer of ["CLAUDE.md", "fleetd/AGENTS.md", "fleetd/src/hub/prompts/defaults/lead.start.md", "docs/prompts/review.md", ".claude/skills/x/SKILL.md", ".cursor/rules/a.md", ".github/copilot-instructions.md", "docs/x.instructions.md"]) {
    expect([steer, matches("docs", file(steer))]).toEqual([steer, false]);
  }
  expect(decide("people", DEFAULT_RISK_RULES, [file("fleetd/src/hub/prompts/defaults/lead.start.md")]).by).toBe("person");
  expect(matches("tests", file("fleetd/test/train.test.ts"))).toBe(true);
  expect(matches("tests", file("src/login_test.go"))).toBe(true);
  expect(matches("migrations", file("src/hub/store/migrations/1_x.sql"))).toBe(true);
  expect(matches("ci", file(".github/workflows/ci.yml"))).toBe(true);
  expect(matches("ci", file(".fleetd/train.json"))).toBe(true);
  expect(matches("secrets", file("config/.env.production"))).toBe(true);
  expect(matches("auth", file("src/auth/session.ts"))).toBe(true);
  expect(matches("auth", file("src/author.ts"))).toBe(false);
  expect(matches("billing", file("app/billing/plans.ts"))).toBe(true);
  expect(matches("infra", file("infra/main.tf"))).toBe(true);
  // A doc renamed from code isn't docs, and a file moved out of auth/ still touches auth.
  expect(matches("docs", { path: "notes.md", previousPath: "src/x.ts", status: "renamed" })).toBe(false);
  const moved: MergeFile = { path: "src/user.ts", previousPath: "src/auth/user.ts", status: "renamed" };
  expect(decide("people", DEFAULT_RISK_RULES, [moved])).toEqual({ by: "person", why: "src/user.ts matches the always-a-person rule auth" });
});

const LOCK_BUMP = [
  "@@ -10,4 +10,4 @@",
  ' "node_modules/left-pad": {',
  '-  "version": "1.2.3",',
  '-  "integrity": "sha512-0123456789abcdefABCDEF0123456789abcdefABCDEF0123456789ab==",',
  '+  "version": "1.4.0",',
  '+  "integrity": "sha512-ZYXWVUTSRQ9876543210zyxwvutsrqponmlkjihgfedcba9876543210==",',
].join("\n");

test("lockfile-bumps: versions move within a major, or within a minor below 1.0.0; nothing else changes", () => {
  expect(lockfileBumpsOnly(LOCK_BUMP)).toBe(true);
  expect(matches("lockfile-bumps", file("package-lock.json", LOCK_BUMP))).toBe(true);
  // Not a lockfile, or added: no.
  expect(matches("lockfile-bumps", file("package.json", LOCK_BUMP))).toBe(false);
  expect(matches("lockfile-bumps", file("package-lock.json", LOCK_BUMP, "added"))).toBe(false);
  // A major bump, a 0.x minor bump, a package added, a hash changed under the same version: no.
  expect(lockfileBumpsOnly(LOCK_BUMP.replace("1.4.0", "2.0.0"))).toBe(false);
  expect(lockfileBumpsOnly(LOCK_BUMP.replace("1.2.3", "0.2.3").replace("1.4.0", "0.3.0"))).toBe(false);
  expect(lockfileBumpsOnly(LOCK_BUMP.replace("0.2.3", "0.2.4").replace("1.2.3", "0.2.3").replace("1.4.0", "0.2.4"))).toBe(true);
  expect(lockfileBumpsOnly(`${LOCK_BUMP}\n+  "resolved": "https://registry.example/x"`)).toBe(false);
  expect(lockfileBumpsOnly(LOCK_BUMP.replace("1.4.0", "1.2.3"))).toBe(false);
  // A different package under the same versions' shape: no.
  expect(lockfileBumpsOnly("@@ -1 +1 @@\n-left-pad@1.2.3\n+right-pad@1.2.4")).toBe(false);
  expect(lockfileBumpsOnly(undefined)).toBe(false);
});

test("formatting: only blank lines and spaces at a line's end; indentation, inner spaces and binaries never count", () => {
  expect(formattingOnly("@@ -1,2 +1,4 @@\n-const a = 1;   \n-b();\r\n+const a = 1;\n+\n+b();\n+   ")).toBe(true);
  // A re-indent moves Python's return out of its if; a space inside a string changes what runs.
  expect(formattingOnly("@@ -1,2 +1,2 @@\n if x:\n-        return x\n+    return x")).toBe(false);
  expect(formattingOnly('@@ -1 +1 @@\n-run("rm -rf / tmp")\n+run("rm -rf /tmp")')).toBe(false);
  expect(formattingOnly("@@ -1 +1 @@\n-const a=1\n+const a = 1")).toBe(false);
  expect(formattingOnly("@@ -1 +1 @@\n-const a = 1\n+const a = 2")).toBe(false);
  expect(formattingOnly(undefined)).toBe(false);
});

test("decide: fleetd merges all; people hold unless every file merges itself; an always-a-person file always holds", () => {
  const code = file("src/app.ts", "@@ -1 +1 @@\n-a\n+b");
  expect(decide("fleetd", DEFAULT_RISK_RULES, [file("db/migrations/1.sql")])).toEqual({ by: "fleetd" });
  expect(decide("people", DEFAULT_RISK_RULES, [file("docs/a.md"), file("src/x.test.ts")])).toEqual({
    by: "rule",
    rule: "every file matches the merges-itself rules docs, tests",
  });
  expect(decide("people", DEFAULT_RISK_RULES, [file("docs/a.md"), code])).toEqual({
    by: "person",
    why: "people merge this bot's PRs, and src/app.ts matches no merges-itself rule",
  });
  // Formatting-only code merges itself, unless it is under an always-a-person rule.
  const fmt = file("src/app.ts", "@@ -1 +1,2 @@\n-a = 1  \n+a = 1\n+");
  expect(decide("people", DEFAULT_RISK_RULES, [fmt]).by).toBe("rule");
  expect(decide("people", DEFAULT_RISK_RULES, [{ ...fmt, path: "src/auth/app.ts" }]).by).toBe("person");
  // Files that couldn't be read, none at all, or no merges-itself rules: a person merges.
  expect(decide("people", DEFAULT_RISK_RULES, undefined).by).toBe("person");
  expect(decide("people", DEFAULT_RISK_RULES, []).by).toBe("person");
  expect(decide("people", { itself: [], person: [] }, [file("docs/a.md")]).by).toBe("person");
  // A glob of the bot's own.
  expect(decide("people", { itself: ["site/**"], person: [] }, [file("site/index.html")])).toEqual({ by: "rule", rule: "every file matches the merges-itself rule site/**" });
});

test("rulesProblems: a kind of the other list, an empty rule or a broken glob can't be saved", () => {
  expect(rulesProblems(DEFAULT_RISK_RULES)).toEqual([]);
  expect(rulesProblems({ itself: ["auth"], person: [""] })).toEqual(["merges itself: auth: auth is a kind of the other list", "always a person: (empty): a rule can't be empty"]);
  expect(rulesProblems({ itself: ["{docs"], person: [] })[0]).toContain("has a { with no }");
});

test("the migration keeps every bot a hub has on fleetd merging; a bot made after it defaults to people", () => {
  const at = MIGRATIONS.findIndex((m) => m.name.endsWith("_who_merges"));
  expect(at).toBeGreaterThan(0);
  const conn = new Database(":memory:", { strict: true });
  migrate(conn, MIGRATIONS.slice(0, at));
  conn.run("INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES ('devbox', 'shop', '', 'x', '{}'), ('devbox', 'blog', '', 'x', '{}')");
  conn.run("INSERT INTO project_settings (machine_id, project_id, chat_tags) VALUES ('devbox', 'shop', 1)");
  migrate(conn, MIGRATIONS);
  expect(mergesOf(conn, { machineId: "devbox", projectId: "shop" })).toBe("fleetd");
  expect(mergesOf(conn, { machineId: "devbox", projectId: "blog" })).toBe("fleetd");
  expect(conn.query("SELECT chat_tags FROM project_settings WHERE project_id = 'shop'").get()).toEqual({ chat_tags: 1 });
  expect(mergesOf(conn, { machineId: "devbox", projectId: "new" })).toBe("people");
  expect(riskRulesOf(conn, { machineId: "devbox", projectId: "shop" })).toEqual(DEFAULT_RISK_RULES);
});

test("project_settings_set and project_set: a person picks who merges and the rules; an agent's key can't", async () => {
  const t = testHub();
  const tools = new Registry();
  registerAll(tools);
  const call = async (tool: string, input: unknown, human = true) => {
    const out = (await tools.call(t.hub, caller("operate", human), tool, input)) as { output?: any; error?: { message?: string; error?: Error } };
    if (out.error) throw new Error(out.error.error?.message ?? out.error.message ?? "refused");
    return out.output;
  };
  // The test hub's bot was made after the migration: people merge it.
  expect(store(t.hub).projectGet(PROJECT)?.merges).toBe("people");
  await expect(call("project_settings_set", { ...PROJECT, merges: "fleetd" }, false)).rejects.toThrow("Only a person picks who merges");
  const set = await call("project_settings_set", { ...PROJECT, merges: "fleetd" });
  expect(set.next).toContain("merges each of its PRs");
  expect(store(t.hub).projectGet(PROJECT)?.merges).toBe("fleetd");
  await call("project_set", { ...PROJECT, merges: "people" });
  expect(store(t.hub).projectGet(PROJECT)?.merges).toBe("people");
  await expect(call("project_settings_set", { ...PROJECT, mergeRules: { itself: ["migrations"], person: [] } })).rejects.toThrow("can't be saved");
  await call("project_settings_set", { ...PROJECT, mergeRules: { itself: [" docs ", "site/**", "docs"], person: ["*.sql"] } });
  expect(riskRulesOf(t.hub.db.conn, PROJECT)).toEqual({ itself: ["docs", "site/**"], person: ["*.sql"] });
  // Back to the defaults is kept as none.
  await call("project_settings_set", { ...PROJECT, mergeRules: DEFAULT_RISK_RULES });
  expect(t.hub.db.conn.query("SELECT merge_rules FROM project_settings WHERE project_id = ?1").get(PROJECT.projectId)).toEqual({ merge_rules: null });
});

test("fleetd project set --merges takes you or fleetd", () => {
  expect(mergesFlag("you")).toBe("people");
  expect(mergesFlag("fleetd")).toBe("fleetd");
  expect(mergesFlag(undefined)).toBeUndefined();
  expect(() => mergesFlag("me")).toThrow("--merges takes you or fleetd");
});
