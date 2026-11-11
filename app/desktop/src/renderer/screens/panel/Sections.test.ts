import { describe, expect, it } from "vitest";
import { SECTIONS, SKILL, listOf, sectionOf, servedSection, shownSections } from "./Sections";
import { PANEL_TABS } from "./tabs";

const agents = SECTIONS[0];

describe("a section the hub serves in part", () => {
  it("drops the views the hub doesn't serve, with a line and tooltip that don't mention them", () => {
    if (agents === undefined) throw new Error("no sections");
    const alone = servedSection(agents, []);
    expect(alone.views).toEqual(["agents"]);
    expect(alone.line).toBe("The AI workers on this project, and what each is doing right now.");
    expect(alone.line).not.toMatch(/browser/u);
    const both = servedSection(agents, ["browser_sessions"]);
    expect(both.views).toEqual(["agents", "sessions"]);
    expect(both.line).toMatch(/screens they use/u);
  });

  it("leaves a section of views that need nothing as it is", () => {
    for (const section of SECTIONS.slice(1).filter((g) => g.id !== "artifacts")) expect(servedSection(section, [])).toBe(section);
  });
});

describe("the panel's one row", () => {
  it("is all the navigation there is: every view lands in one of its tabs, and none has tabs of its own", () => {
    const lands = Object.fromEntries(PANEL_TABS.map((t) => [t.id, sectionOf(t.id).id]));
    expect(lands).toEqual({
      agents: "agents",
      sessions: "agents",
      prs: "shipping",
      train: "shipping",
      checklist: "plan",
      asked: "plan",
      artifacts: "artifacts",
      activity: "history",
      decisions: "history",
      skills: "skills",
    });
    // A tab opens on its list; the views after it are a place in that list or a row away, never a second row.
    expect(SECTIONS.map((g) => `${g.id}:${listOf(g.id)}`)).toEqual(["agents:agents", "shipping:prs", "plan:checklist", "artifacts:artifacts", "history:activity"]);
  });
});

describe("a section the hub doesn't serve at all", () => {
  it("isn't there until the hub serves its view", () => {
    expect(shownSections([], ["artifacts"]).map((g) => g.id)).not.toContain("artifacts");
    expect(shownSections(["artifacts"], ["artifacts"]).map((g) => g.id)).toContain("artifacts");
  });
});

describe("a tucked section", () => {
  it("stays off the row unless the panel asks for it: Artifacts once there is one or while it's open", () => {
    expect(shownSections(["artifacts"]).map((g) => g.id)).toEqual(["agents", "shipping", "plan", "history"]);
    expect(shownSections(["artifacts"], ["plan", "artifacts"]).map((g) => g.id)).toEqual(["agents", "shipping", "plan", "artifacts", "history"]);
  });

  it("never has a Skills tab: one skill opens with no tab, its list in the project's settings", () => {
    expect(shownSections(["artifacts"], ["skills"]).map((g) => g.id)).toEqual(["agents", "shipping", "plan", "history"]);
    expect(sectionOf("skills")).toBe(SKILL);
  });
});
