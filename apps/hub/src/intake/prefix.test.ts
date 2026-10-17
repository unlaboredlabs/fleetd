import type { ProjectSummary } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { matchProject, parseIntent } from "./prefix.ts";

describe("parseIntent", () => {
  it.each([
    ["fix: the lab README has a typo", { template: "bugfix", prefix: "fix:" }],
    ["bug: login fails", { template: "bugfix", prefix: "bug:" }],
    ["Fix: capitals work", { template: "bugfix", prefix: "fix:" }],
    ["research:does caching help", { template: "research", prefix: "research:" }],
    ["finish: everything in flight", { template: "finish-all", prefix: "finish:" }],
    ["  fix :  spaces around the colon", { template: "bugfix", prefix: "fix:" }],
    ["@repo-a add a /health endpoint", { project: "repo-a" }],
    ["@Repo-A: add a /health endpoint", { project: "Repo-A" }],
    ["@repo-a fix: the README typo", { project: "repo-a", template: "bugfix", prefix: "fix:" }],
    ["fix: @repo-a the README typo", { project: "repo-a", template: "bugfix", prefix: "fix:" }],
    ["add a /health endpoint", {}],
    ["fix the README typo", {}],
    ["note: not a template", {}],
    ["fixes: not a template either", {}],
    ["email me@example.com about it", {}],
    ["fix: research: only the first prefix counts", { template: "bugfix", prefix: "fix:" }],
  ])("%j", (text, expected) => {
    expect(parseIntent(text)).toEqual(expected);
  });
});

const project = (machineId: string, projectId: string, title: string, workspaceRoot = `/w/${projectId}`) =>
  ({ machineId, projectId, title, workspaceRoot, threads: { running: 0, waiting: 0, idle: 0, failed: 0 }, lastActivityAt: "2026-10-17T10:00:00.000Z" }) as ProjectSummary;

describe("matchProject", () => {
  const projects = [
    project("lab-a", "p1", "Repo A", "/lab/repo-a"),
    project("lab-b", "p2", "fleetd lab", "/home/w/src/fleetd-lab"),
    project("lab-a", "p3", "docs"),
    project("lab-b", "p4", "docs"),
  ];
  const pick = (name: string) => {
    const match = matchProject(name, projects);
    return match.kind === "one" ? match.project.projectId : match.kind === "many" ? match.projects.map((p) => p.projectId) : "none";
  };

  it.each([
    ["repo-a", "p1"],
    ["REPO-A", "p1"],
    ["repo a", "p1"],
    ["fleetd-lab", "p2"],
    ["Fleetd Lab", "p2"],
    ["docs", ["p3", "p4"]],
    ["repo", "none"],
    ["", "none"],
  ])("@%s → %j", (name, expected) => {
    expect(pick(name)).toEqual(expected);
  });
});
