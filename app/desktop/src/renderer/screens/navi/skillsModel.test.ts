import { describe, expect, it } from "vitest";
import type { SkillSummary } from "../../../shared/contracts";
import { body, byWord, grouped, metaLine } from "./skillsModel";

const NOW = new Date(2026, 9, 31, 12, 0).getTime();
const at = (h: number) => new Date(2026, 9, 31, h, 5).toISOString();

const skill = (name: string, extra: Partial<SkillSummary> = {}): SkillSummary => ({ name, origin: "project", description: `${name} things.`, ...extra });

describe("a Navi's skills", () => {
  it("groups what it learned, what was installed, every project's and its folder's, each by name", () => {
    const g = grouped([
      skill("taxes"),
      skill("groceries"),
      skill("pdf", { install: { source: "a/b", url: "u", ref: "HEAD", commit: "c".repeat(40), path: "", installedAt: at(1) } }),
      skill("standup", { origin: "global" }),
      skill("taxes", { origin: "global", shadowedBy: "project" }),
      skill("notes", { origin: "repo_claude" }),
    ]);
    expect(g.map((x) => [x.group, x.rows.map((r) => r.name)])).toEqual([
      ["learned", ["groceries", "taxes"]],
      ["installed", ["pdf"]],
      ["every", ["standup"]],
      ["folder", ["notes"]],
    ]);
  });

  it("says who changed it last, when, and when it was last used", () => {
    const changed = { version: 2, author: "agent" as const, by: "Home", at: at(9) };
    expect(metaLine(skill("taxes", { changed, lastUsedAt: at(11) }), NOW)).toBe("Changed today 09:05 by Home · used today 11:05");
    expect(metaLine(skill("taxes", { off: true, changed: { ...changed, author: "person", by: "Ana" } }), NOW, "Ana")).toBe("Off · Changed today 09:05 by you · not used yet");
    expect(byWord({ author: "agent", by: "Ana" }, "Ana")).toBe("Ana");
  });

  it("renders a SKILL.md without its frontmatter", () => {
    expect(body("---\nname: taxes\ndescription: File them.\n---\n\n# Taxes\n\n1. Log in.\n")).toBe("# Taxes\n\n1. Log in.\n");
    expect(body("# Just text\n")).toBe("# Just text\n");
  });
});
