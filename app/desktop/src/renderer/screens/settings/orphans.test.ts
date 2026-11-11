import { describe, expect, it } from "vitest";
import type { RetiredPromptOverride } from "./contracts";
import { orphanAdvice, orphanTitle, targetName, whyLine } from "./orphans";

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
  it("names the prompt it edited in plain words, and says where its intent could go", () => {
    expect(orphanTitle(wake)).toBe('The lead\'s "task finished" note');
    expect(orphanTitle(router)).toBe("Order router");
    expect(targetName(wake)).toBe("Lead's role, rules and playbooks");
    expect(orphanAdvice(wake)).toBe("fleetd doesn't send it any more. If you still want what it said, copy it into Lead's role, rules and playbooks.");
    expect(orphanAdvice(router)).toMatch(/no other prompt takes its place\. Copy what you still need into your instructions\.$/u);
  });

  it("ends the hub's reason with one full stop", () => {
    expect(whyLine(wake)).toBe("Notes to the lead are now fixed event lines that fleetd writes.");
    expect(whyLine(router)).toBe("Orders now go to a project's lead in its chat.");
  });
});
