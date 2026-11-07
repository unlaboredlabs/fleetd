import { describe, expect, it } from "vitest";
import type { SkillSummary } from "../../../shared/contracts";
import { body, byWord, metaLine } from "./skillsModel";

const NOW = new Date(2026, 9, 31, 12, 0).getTime();
const at = (h: number) => new Date(2026, 9, 31, h, 5).toISOString();

const skill = (name: string, extra: Partial<SkillSummary> = {}): SkillSummary => ({ name, origin: "project", description: `${name} things.`, ...extra });

describe("a project's skills", () => {
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
