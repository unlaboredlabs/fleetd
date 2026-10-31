import { describe, expect, it } from "vitest";
import { ago, diffChunks, diffSummary, isOff, kindOf, offers, rowLine, skillGroups, skillsShown, sourceLine, splitSkill, versionLine, whoOf, type Skill, type SkillVersion } from "./skillsModel";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const clock = { nowMs: NOW };
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const skill = (name: string, extra: Partial<Skill> = {}): Skill => ({ name, description: `${name} steps`, origin: "project", ...extra });
const install = { source: "acme/skills", url: "https://github.com/acme/skills", ref: "HEAD", path: "", commit: "abc", installedAt: hoursAgo(100) };
const version = (n: number, extra: Partial<SkillVersion> = {}): SkillVersion => ({ version: n, author: "agent", by: "Nova", at: hoursAgo(2), why: "Learned the export step", ...extra });

describe("the Skills list", () => {
  it("shows only on a hub that keeps skills' versions", () => {
    const live = { phase: "live", hub: "http://devbox:4790", protocol: 1 } as const;
    expect(skillsShown({ ...live, features: ["presence", "navi_skills"] })).toBe(true);
    expect(skillsShown({ ...live, features: ["presence"] })).toBe(false);
    expect(skillsShown(live)).toBe(false);
    expect(skillsShown({ phase: "connecting", hub: "http://devbox:4790", attempt: 1 })).toBe(false);
  });

  it("puts the Navi's own first, then the installed ones, then its folder's, leaving out empty sections", () => {
    const skills = [skill("pdf", { origin: "global" }), skill("invoices"), skill("deploy", { install }), skill("lint", { origin: "repo_agents" })];
    expect(skillGroups(skills, "Nova").map((g) => [g.header, g.rows.map((s) => s.name)])).toEqual([
      ["Made by Nova", ["invoices"]],
      ["Installed", ["pdf", "deploy"]],
      ["In its folder", ["lint"]],
    ]);
    expect(skillGroups([skill("pdf", { origin: "global" })], "Nova").map((g) => g.kind)).toEqual(["installed"]);
    expect(skillGroups([], "Nova")).toEqual([]);
  });

  it("tells its own from an installed one", () => {
    expect(kindOf(skill("a"))).toBe("own");
    expect(kindOf(skill("a", { install }))).toBe("installed");
    expect(kindOf(skill("a", { origin: "global" }))).toBe("installed");
    expect(kindOf(skill("a", { origin: "repo_claude" }))).toBe("folder");
  });

  it("says the newer of its last change and its last use", () => {
    expect(rowLine(skill("a", { changed: version(3) }), clock, "Ada")).toBe("Changed by Nova · 2h ago");
    expect(rowLine(skill("a", { changed: version(1) }), clock, "Ada")).toBe("Made by Nova · 2h ago");
    expect(rowLine(skill("a", { changed: version(2, { author: "person", by: "Ada", at: hoursAgo(30) }) }), clock, "Ada")).toBe("Changed by you · yesterday");
    expect(rowLine(skill("a", { changed: version(2, { at: hoursAgo(30) }), lastUsedAt: hoursAgo(3) }), clock, "Ada")).toBe("Used 3h ago");
    expect(rowLine(skill("a", { changed: version(2), lastUsedAt: hoursAgo(30) }), clock, "Ada")).toBe("Changed by Nova · 2h ago");
    expect(rowLine(skill("a", { lastUsedAt: hoursAgo(26) }), clock, "Ada")).toBe("Used yesterday");
  });

  it("falls back to where an installed one came from", () => {
    expect(rowLine(skill("a", { install }), clock, undefined)).toBe("From acme/skills");
    expect(rowLine(skill("a", { origin: "global" }), clock, undefined)).toBe("Hub-wide");
    expect(rowLine(skill("a"), clock, undefined)).toBeUndefined();
  });

  it("words how long ago in a few words", () => {
    expect(ago(new Date(NOW - 20_000).toISOString(), clock)).toBe("just now");
    expect(ago(new Date(NOW - 5 * 60_000).toISOString(), clock)).toBe("5 min ago");
    expect(ago(hoursAgo(23), clock)).toBe("23h ago");
    expect(ago(hoursAgo(47), clock)).toBe("yesterday");
    expect(ago(hoursAgo(72), clock)).toBe("3 days ago");
    expect(ago(hoursAgo(24 * 20), clock)).not.toMatch(/ago/u);
  });
});

describe("a skill's view", () => {
  it("offers edit and delete for the Navi's own alone, and turning off to its owner", () => {
    expect(offers(skill("a"), true)).toEqual({ edit: true, delete: true, history: true, turnOff: true });
    expect(offers(skill("a", { install }), true)).toEqual({ edit: false, delete: false, history: true, turnOff: true });
    expect(offers(skill("a", { origin: "global" }), true)).toEqual({ edit: false, delete: false, history: true, turnOff: true });
    expect(offers(skill("a", { origin: "repo_agents" }), true)).toEqual({ edit: false, delete: false, history: false, turnOff: false });
    expect(offers(skill("a", { origin: "repo_claude" }), true)).toEqual({ edit: false, delete: false, history: false, turnOff: false });
    expect(offers(skill("a"), false)).toEqual({ edit: false, delete: false, history: true, turnOff: false });
  });

  it("never shows a skill from its folder as off: the hub can't turn one off", () => {
    expect(isOff(skill("a", { off: true }))).toBe(true);
    expect(isOff(skill("a", { origin: "global", off: true }))).toBe(true);
    expect(isOff(skill("a", { origin: "repo_agents", off: true }))).toBe(false);
    expect(isOff(skill("a"))).toBe(false);
  });

  it("splits the frontmatter from the steps", () => {
    const text = '---\nname: weekly-invoices\ndescription: "Sends the week\'s invoices"\n---\n\n# Weekly invoices\n\n1. Export\n';
    expect(splitSkill(text)).toEqual({ fields: { name: "weekly-invoices", description: "Sends the week's invoices" }, body: "# Weekly invoices\n\n1. Export\n" });
    expect(splitSkill("# No frontmatter\n")).toEqual({ fields: {}, body: "# No frontmatter\n" });
  });

  it("says where it is from and how many versions it has", () => {
    expect(sourceLine(skill("a"), "Nova", 4)).toBe("Made by Nova · 4 versions");
    expect(sourceLine(skill("a"), "Nova", 1)).toBe("Made by Nova");
    expect(sourceLine(skill("a", { install }), "Nova", 0)).toBe("Installed from acme/skills");
    expect(sourceLine(skill("a", { origin: "global" }), "Nova", 2)).toBe("Hub-wide · 2 versions");
    expect(sourceLine(skill("a", { origin: "repo_agents", path: ".agents/skills/a/SKILL.md" }), "Nova", 0)).toBe(".agents/skills/a/SKILL.md");
  });
});

describe("its history", () => {
  it("names each version by its why, who and when, and you as you", () => {
    expect(versionLine(version(3), clock, "Ada")).toEqual({ title: "Learned the export step", detail: "Nova · 2h ago" });
    const { why: _, ...bare } = version(4, { author: "person", by: "Ada" });
    expect(versionLine(bare, clock, "Ada")).toEqual({ title: "Edited", detail: "You · 2h ago" });
    expect(whoOf({ author: "person", by: "Ben" }, "Ada")).toBe("Ben");
    expect(whoOf({ author: "agent", by: "Ada" }, "Ada")).toBe("Ada");
  });

  it("shows a change with a little around it, folding the long unchanged runs", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${String(i + 1)}`);
    const before = lines(20).join("\n");
    const after = lines(20)
      .map((l) => (l === "line 10" ? "line ten, now longer" : l))
      .join("\n");
    const chunks = diffChunks(before, after, new Set());
    expect(chunks.map((c) => (c.t === "fold" ? `fold ${String(c.count)}` : `${c.line.op} ${c.line.text}`))).toEqual([
      "fold 7",
      "same line 8",
      "same line 9",
      "del line 10",
      "add line ten, now longer",
      "same line 11",
      "same line 12",
      "fold 8",
    ]);
    const opened = diffChunks(before, after, new Set([0]));
    expect(opened.filter((c) => c.t === "fold")).toHaveLength(1);
    expect(opened[0]).toMatchObject({ t: "line", line: { op: "same", text: "line 1" } });
  });

  it("marks the words that changed in an edited line", () => {
    const [del, add] = diffChunks("Export the invoices as CSV", "Export the invoices as PDF", new Set());
    expect(del).toMatchObject({ t: "line", line: { op: "del", words: [{ op: "same", text: "Export the invoices as " }, { op: "del", text: "CSV" }] } });
    expect(add).toMatchObject({ t: "line", line: { op: "add", words: [{ op: "same", text: "Export the invoices as " }, { op: "add", text: "PDF" }] } });
  });

  it("sums a change up", () => {
    expect(diffSummary("a\nb", "a\nb\nc\nd")).toBe("2 lines added");
    expect(diffSummary("a\nb\nc", "a")).toBe("2 lines removed");
    expect(diffSummary("a\nb", "a\nc")).toBe("1 line added, 1 removed");
    expect(diffSummary("a", "a")).toBe("No change in its text");
  });
});
