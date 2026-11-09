// The hub's skills (saves_tests.rs, install.rs tests).
import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerAll } from "../src/hub/serve/areas.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { chat } from "../src/hub/chat/index.ts";
import { leadCalls } from "../src/hub/lead_calls/index.ts";
import type { LeadCaller } from "../src/hub/leads/seams.ts";
import { checkSkillMd, descriptionOf, frontmatter } from "../src/hub/skills/frontmatter.ts";
import { Skills } from "../src/hub/skills/index.ts";
import { find, parse } from "../src/hub/skills/install.ts";
import { registerLeadCalls } from "../src/hub/skills/calls.ts";
import { caller, PROJECT, testHub } from "./hub-helpers.ts";

const md = (name: string, description = "Does a thing.") => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const tools = new Registry();
registerAll(tools);
const person = caller("admin", true, { personId: "p_ada", name: "Ada" });

test("frontmatter: plain, quoted and block scalars; the checks", () => {
  expect(frontmatter('---\nname: deploy\ndescription: "Ships it: \\"fast\\""\n---\n')).toEqual({ name: "deploy", description: 'Ships it: "fast"' });
  expect(frontmatter("---\nname: a # note\ndescription: >\n  one\n  two\n---\n")).toEqual({ name: "a", description: "one two" });
  expect(descriptionOf("---\ndescription: |\n  line one\n  line two\n---\n")).toBe("line one line two");
  expect(checkSkillMd("deploy", "# no frontmatter")).toBe("SKILL.md starts with frontmatter: ---, name and description, ---.");
  expect(checkSkillMd("deploy", md("ship"))).toBe("The frontmatter names it ship, and its folder is deploy: they must match.");
  expect(checkSkillMd("deploy", "---\nname: deploy\n---\n")).toContain("needs a description");
  expect(checkSkillMd("deploy", md("deploy"))).toBeUndefined();
});

test("a person's skill: set, versions, revert, off, delete; a secret is refused", async () => {
  const { hub, done } = testHub();
  const call = (tool: string, input: Record<string, unknown>) => tools.call(hub, person, tool, input) as Promise<{ output?: any; error?: any }>;
  const base = { scope: "project", projectRef: PROJECT, name: "deploy" };
  expect((await call("skill_set", { ...base, text: md("deploy"), create: true })).output.skill).toMatchObject({ name: "deploy", origin: "project", description: "Does a thing." });
  expect((await call("skill_set", { ...base, text: md("deploy"), create: true })).error.error.message).toBe("There is already a skill called deploy here.");
  await call("skill_set", { ...base, text: md("deploy", "Does it better."), why: "clearer" });
  const got = (await call("skill_get", { origin: "project", projectRef: PROJECT, name: "deploy" })).output;
  expect(got.versions.map((v: { version: number; by: string; why?: string }) => [v.version, v.by, v.why])).toEqual([
    [2, "Ada", "clearer"],
    [1, "Ada", undefined],
  ]);
  expect((await call("skill_get", { origin: "project", projectRef: PROJECT, name: "deploy", version: 1 })).output.text).toBe(md("deploy"));
  expect((await call("skill_revert", { ...base, version: 1 })).output.skill.description).toBe("Does a thing.");
  expect((await call("skill_set", { ...base, text: md("deploy", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789") })).error.error.message).toContain("looks like a secret");
  await call("skill_set", { scope: "global", name: "deploy", text: md("deploy", "Global one.") });
  expect(await call("skill_off", { projectRef: PROJECT, name: "deploy", off: true })).toMatchObject({ output: { ok: true } });
  const listed = (await call("skills_list", { projectRef: PROJECT })).output;
  expect(listed.repoUnavailable).toBe("lab-a is offline, so its repo's skills aren't listed.");
  expect(listed.skills.map((s: { origin: string; shadowedBy?: string; off?: boolean }) => [s.origin, s.shadowedBy, s.off])).toEqual([
    ["project", undefined, true],
    ["global", "project", true],
  ]);
  expect(Skills.of(hub).bundles(PROJECT)).toEqual([]);
  await call("skill_off", { projectRef: PROJECT, name: "deploy", off: false });
  expect(Skills.of(hub).bundles(PROJECT).map((b) => [b.name, b.origin])).toEqual([["deploy", "project"]]);
  expect(await call("skill_delete", { ...base })).toMatchObject({ output: { ok: true } });
  expect((await call("skill_delete", { ...base })).error.error.code).toBe("not_found");
  expect(await tools.call(hub, caller("operate"), "skill_set", { ...base, text: md("deploy") })).toMatchObject({ error: { error: { code: "forbidden" } } });
  expect(await tools.call(hub, caller("operate", true), "skill_set", { scope: "global", name: "x", text: md("x") })).toMatchObject({ error: { error: { code: "forbidden" } } });
  done();
});

test("a lead saves its project's skill with a chat line; a task may not", async () => {
  const { hub, done } = testHub();
  registerLeadCalls(hub);
  const lead: LeadCaller = { projectRef: PROJECT, by: "lead:lab-a/p1", agent: { kind: "lead" } };
  const save = leadCalls(hub).handler("skill_save");
  const out = await save?.(lead, { op: "skill_save", name: "triage", text: md("triage"), why: "how we sort bugs" });
  expect(out).toMatchObject({ name: "triage", version: 1, created: true });
  expect(chat(hub).page(PROJECT, undefined, undefined, 5).messages.map((m) => m.text)).toEqual(["Saved a new skill, triage: how we sort bugs"]);
  expect(() => save?.({ ...lead, agent: { kind: "task", taskId: "T1" } }, { op: "skill_save", name: "triage", text: md("triage"), why: "x" })).toThrow(
    "Only the project's lead saves its skills.",
  );
  done();
});

test("sources parse as skills.sh writes them", () => {
  expect(parse("acme/tools")).toEqual({ url: "https://github.com/acme/tools.git", gitRef: "HEAD", path: "" });
  expect(parse("acme/tools@deploy")).toMatchObject({ skill: "deploy" });
  expect(parse("https://github.com/acme/tools/tree/main/skills/deploy")).toEqual({ url: "https://github.com/acme/tools.git", gitRef: "main", path: "skills/deploy" });
  expect(parse("git@example.com:acme/tools.git")).toMatchObject({ url: "git@example.com:acme/tools.git" });
  expect(() => parse("-x")).toThrow("is not a source");
  expect(() => parse("acme")).toThrow("is not a source");
});

test("a person installs from a local repo, pinned; a lead may not; a link is refused", async () => {
  const { hub, home, done } = testHub();
  const repo = join(home, "repo");
  mkdirSync(join(repo, "skills", "deploy"), { recursive: true });
  writeFileSync(join(repo, "skills", "deploy", "SKILL.md"), md("deploy"));
  writeFileSync(join(repo, "skills", "deploy", "run.sh"), "echo hi\n");
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd: repo });
  git("init", "--quiet");
  git("add", ".");
  git("commit", "--quiet", "-m", "one");
  const out = (await tools.call(hub, person, "skill_install", { scope: "project", projectRef: PROJECT, source: `file://${repo}` })) as { output: any };
  expect(out.output.installed.map((s: { name: string; files: string[]; install: { ref: string } }) => [s.name, s.files, s.install.ref])).toEqual([["deploy", ["run.sh"], "HEAD"]]);
  const again = (await tools.call(hub, person, "skill_update", { scope: "project", projectRef: PROJECT, name: "deploy" })) as { output: any };
  expect(again.output).toMatchObject({ updated: false, next: "Already at the newest commit." });
  registerLeadCalls(hub);
  const lead: LeadCaller = { projectRef: PROJECT, by: "lead:lab-a/p1", agent: { kind: "lead" } };
  const refused = await Promise.resolve(leadCalls(hub).handler("skill_install")?.(lead, { op: "skill_install", scope: "project", source: `file://${repo}` })).catch(
    (error: Error) => error.message,
  );
  expect(refused).toBe("A lead installs from a remote source only.");
  symlinkSync("/etc/hostname", join(repo, "skills", "deploy", "host"));
  expect(() => find(repo, { url: `file://${repo}`, gitRef: "HEAD", path: "" })).toThrow("holds a link, host");
  done();
  // Git runs a process for each step and the install clones: a loaded machine takes longer than bun's 5 s default.
}, 30_000);
