import { describe, expect, it } from "vitest";
import type { SkillSummary } from "../../../shared/contracts";
import { parseRoute } from "./route";
import { searchSettings } from "./search";
import { editable, groups, installLine, isSkillName, nameProblem, rowKey, shadowLine, slug, template } from "./skillsModel";

const skill = (over: Partial<SkillSummary>): SkillSummary => ({ name: "release", origin: "global", description: "", files: [], ...over });

describe("Settings → Skills", () => {
  it("edits the hub's skills only; the repo's change in the repo", () => {
    expect(editable("project")).toBe(true);
    expect(editable("global")).toBe(true);
    expect(editable("repo_agents")).toBe(false);
    expect(editable("repo_claude")).toBe(false);
  });

  it("takes the Agent Skills spec's names, and turns a typed one into one", () => {
    expect(isSkillName("pr-review")).toBe(true);
    for (const bad of ["", "PR", "-a", "a-", "a--b", "a_b", "a".repeat(65)]) expect(isSkillName(bad)).toBe(false);
    expect(slug(" Release Notes ")).toBe("release-notes");
    expect(slug("release_notes")).toBe("release-notes");
    expect(nameProblem("", [])).toBe("Give it a name.");
    expect(nameProblem("a--b", [])).toMatch(/single hyphens/u);
    expect(nameProblem("release", ["release"])).toBe("There is already a skill called release here.");
    expect(nameProblem("release", [])).toBeNull();
  });

  it("starts a new skill from frontmatter with its name and a description to fill in", () => {
    expect(template("deploy")).toMatch(/^---\nname: deploy\ndescription: .+\n---\n/u);
  });

  it("says where an installed skill is pinned, and which one outranks a shadowed one", () => {
    const install = { source: "acme/skills", url: "https://github.com/acme/skills.git", ref: "HEAD", commit: "0123456789abcdef0123456789abcdef01234567", path: "skills/release", installedAt: "2026-10-25T10:00:00.000Z" };
    expect(installLine(skill({ install }))).toBe("Installed from acme/skills, pinned");
    expect(installLine(skill({ install: { ...install, ref: "v2" } }))).toBe("Installed from acme/skills (v2), pinned");
    expect(installLine(skill({}))).toBeNull();
    expect(shadowLine(skill({ shadowedBy: "repo_agents" }))).toBe("Agents use the Repo · .agents/skills one of this name instead.");
    expect(shadowLine(skill({}))).toBeNull();
  });

  it("groups the list in precedence order, one row per origin and name", () => {
    const list = [skill({ origin: "global" }), skill({ origin: "repo_claude", name: "triage" }), skill({ origin: "repo_agents" })];
    expect(groups(list).map((g) => g.origin)).toEqual(["repo_agents", "repo_claude", "global"]);
    expect(rowKey(list[0] ?? skill({}))).toBe("global/release");
  });

  it("is a page of its own, found by search and linked per project", () => {
    expect(searchSettings("skills.sh")[0]?.tab).toBe("skills");
    expect(parseRoute("#/settings/skills?for=devbox/shop")).toMatchObject({ tab: "skills", for: "devbox/shop" });
  });
});
