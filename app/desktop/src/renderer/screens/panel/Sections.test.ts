import { describe, expect, it } from "vitest";
import { SECTIONS, servedSection } from "./Sections";

const agents = SECTIONS[0];

describe("a section the hub serves in part", () => {
  it("drops the views the hub doesn't serve, with a line and tooltip that don't mention them", () => {
    if (agents === undefined) throw new Error("no sections");
    const alone = servedSection(agents, []);
    expect(alone.views.map(([tab]) => tab)).toEqual(["agents"]);
    expect(alone.line).toBe("The AI workers on this project, and what each is doing right now.");
    expect(alone.line).not.toMatch(/browser/u);
    const both = servedSection(agents, ["browser_sessions"]);
    expect(both.views.map(([tab, words]) => `${tab}:${words}`)).toEqual(["agents:Agents", "sessions:Screens"]);
    expect(both.line).toMatch(/screens they use/u);
  });

  it("leaves a section of views that need nothing as it is", () => {
    for (const section of SECTIONS.slice(1)) expect(servedSection(section, [])).toBe(section);
  });
});
