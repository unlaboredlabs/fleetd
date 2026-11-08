import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "../../../shared/contracts";
import { deleteWords, isYours, nameProblem, sidebarOrder } from "./model";

const project = (title: string, extra: Partial<ProjectSummary> = {}): { project: ProjectSummary } => ({
  project: {
    machineId: "devbox",
    projectId: title.toLowerCase(),
    title,
    workspaceRoot: `/home/dev/${title}`,
    lastActivityAt: "2026-10-26T09:00:00.000Z",
    threads: { failed: 0, idle: 0, running: 0, waiting: 0 },
    ...extra,
  },
});

describe("the sidebar's default order", () => {
  it("puts Only-me projects first, keeps each part's order, and leaves archived ones out", () => {
    const rows = [
      project("billing"),
      project("Ada", { onlyMe: true }),
      project("storefront"),
      project("Home", { onlyMe: true }),
      project("Taxes", { onlyMe: true, archivedAt: "2026-10-20T09:00:00.000Z" }),
      project("legacy", { archivedAt: "2026-10-20T09:00:00.000Z" }),
    ];
    expect(sidebarOrder(rows).map((r) => r.project.title)).toEqual(["Ada", "Home", "billing", "storefront"]);
  });
  it("never reads the old kind", () => {
    expect(sidebarOrder([project("billing"), project("Ada", { kind: "assistant" })]).map((r) => r.project.title)).toEqual(["billing", "Ada"]);
  });
});

describe("whose project it is", () => {
  const me = "p_aaaaaaaa";
  it("is yours with your owner, or with none (a hub without people); a teammate's never is", () => {
    expect(isYours({ owner: me }, me)).toBe(true);
    expect(isYours({}, me)).toBe(true);
    expect(isYours({}, undefined)).toBe(true);
    expect(isYours({ owner: "p_bbbbbbbb" }, me)).toBe(false);
    // Until the hub says who you are, one with an owner waits.
    expect(isYours({ owner: me }, undefined)).toBe(false);
  });
});

describe("a project's name", () => {
  it("takes one line under 80 characters, and says nothing about an empty box", () => {
    expect(nameProblem("")).toBeUndefined();
    expect(nameProblem("Ada")).toBeUndefined();
    expect(nameProblem("a".repeat(81))).toMatch(/80/u);
    expect(nameProblem("Ada\nLovelace")).toBe("One line");
  });
});

describe("a project's delete", () => {
  it("names what is erased and the folder the tickbox deletes", () => {
    const w = deleteWords("Ada", "devbox", "~/fleetd/ada");
    expect(w.message).toMatch(/^Ada stops now.*chat, memory, skills, approvals, purchases, automations and sign-ins\. The files in its folder stay unless you tick below\./u);
    expect(w.folder).toBe("Also delete its folder, ~/fleetd/ada");
  });
});
