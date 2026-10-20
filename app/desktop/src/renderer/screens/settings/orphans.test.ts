import { describe, expect, it } from "vitest";
import type { ProjectSummary, RetiredPromptOverride } from "./contracts";
import { editScopeWords, orphanAdvice, orphanHeadline, targetName, whyLine } from "./orphans";

const projects = [{ machineId: "devbox", projectId: "storefront", title: "acme/storefront" }] as ProjectSummary[];
const wake: RetiredPromptOverride = {
  id: "wake.task_result",
  title: "Wake: task finished",
  scope: "global",
  text: "Read the result in full.",
  suggestedTarget: "lead.start",
  why: "wakes are now a fixed event format",
};
const router: RetiredPromptOverride = {
  id: "router",
  title: "Order router",
  scope: "project",
  projectRef: { machineId: "devbox", projectId: "storefront" },
  text: "Route checkout work to storefront.",
  why: "orders now go to a project's lead in its chat.",
};

describe("edits that no longer apply", () => {
  it("says whose edit it was, that it no longer applies, and where its intent could go", () => {
    expect(orphanHeadline(wake, projects)).toBe("Your edit to Wake: task finished (hub-wide) no longer applies.");
    expect(orphanHeadline(router, projects)).toBe("Your edit to Order router (for acme/storefront) no longer applies.");
    expect(targetName(wake)).toBe("Lead's role, rules and playbooks");
    expect(orphanAdvice(wake)).toBe("fleetd doesn't send it any more. If you still want what it said, copy it into Lead's role, rules and playbooks.");
    expect(orphanAdvice(router)).toMatch(/no other prompt takes its place\. Copy what you still need into your instructions\.$/u);
  });

  it("ends the hub's reason with one full stop, and names an unknown project by its id", () => {
    expect(whyLine(wake)).toBe("Wakes are now a fixed event format.");
    expect(whyLine(router)).toBe("Orders now go to a project's lead in its chat.");
    expect(editScopeWords(router, undefined)).toBe("for storefront");
  });

});
