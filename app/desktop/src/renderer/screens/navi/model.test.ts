import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "../../../shared/contracts";
import { nameProblem, orderWords, sidebarOrder, splitNavis } from "./model";

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

describe("the sidebar's Navis", () => {
  const rows = [
    project("billing"),
    project("Ada", { kind: "assistant" }),
    project("storefront"),
    project("Home", { kind: "assistant" }),
    project("Taxes", { kind: "assistant", archivedAt: "2026-10-20T09:00:00.000Z" }),
  ];
  it("pins the Navis in use above the projects, and leaves an archived one out of both", () => {
    const { navis, projects } = splitNavis(rows);
    expect(navis.map((r) => r.project.title)).toEqual(["Ada", "Home"]);
    expect(projects.map((r) => r.project.title)).toEqual(["billing", "storefront"]);
    expect(sidebarOrder(rows).map((r) => r.project.title)).toEqual(["Ada", "Home", "billing", "storefront"]);
  });
  it("takes a project of another, newer kind as a project", () => {
    expect(splitNavis([project("x", { kind: "team" })]).projects).toHaveLength(1);
  });
});

describe("a Navi's name", () => {
  it("takes one line under 80 characters, and says nothing about an empty box", () => {
    expect(nameProblem("")).toBeUndefined();
    expect(nameProblem("Ada")).toBeUndefined();
    expect(nameProblem("a".repeat(81))).toMatch(/80/u);
    expect(nameProblem("Ada\nLovelace")).toBe("One line");
  });
});

describe("the work a Navi asked for", () => {
  it("says each order's state in a word", () => {
    const order = { workstreamId: "W12", title: "Saved carts" };
    expect(orderWords({ ...order, state: "open" })).toBe("In progress");
    expect(orderWords({ ...order, state: "done" })).toBe("Done");
    expect(orderWords({ ...order, state: "stopped" })).toBe("Stopped");
  });
});
