import { describe, expect, it } from "vitest";
import type { ProjectRepo, ProjectSettings } from "../../../shared/contracts";
import { addInput, applied, checkoutPath, isOwn, sourceProblem } from "./repoModel";

const project: ProjectSettings = {
  machineId: "devbox",
  projectId: "p1",
  title: "storefront",
  workspaceRoot: "/home/w/src/storefront",
  keepWorktrees: false,
  setup: { commands: ["pnpm install"], timeoutSec: 600, runAnyway: false, inputs: [] },
  env: [],
};

describe("Settings → Projects → Repos", () => {
  it("reads the project's setup and preview while the hub has no answer for the repo", () => {
    expect(applied(project, undefined)).toEqual({ setup: { own: false, line: "pnpm install" }, preview: { own: false, line: null } });
  });

  it("tells a repo's own preview from the project's setup it falls back to", () => {
    const repo = { ...project, repo: "web", preview: { web: { start: "pnpm dev --port $PORT" } } };
    expect(applied(project, repo)).toEqual({ setup: { own: false, line: "pnpm install" }, preview: { own: true, line: "pnpm dev --port $PORT" } });
  });

  it("adds a path as a checkout and anything else as a GitHub repo, with a name only when it is one", () => {
    expect(addInput(project, " /home/w/src/api ", "")).toEqual({ machineId: "devbox", projectId: "p1", path: "/home/w/src/api" });
    expect(addInput(project, "acme/web", "front")).toEqual({ machineId: "devbox", projectId: "p1", name: "front", url: "acme/web" });
    expect(addInput(project, "  ", "")).toBeNull();
    expect(addInput(project, "acme/web", "Front End")).toBeNull();
    // A path relative to a home or working directory isn't taken for a GitHub repo: it asks for the full path.
    for (const relative of ["~/src/api", "./api", "../api", "~"]) {
      expect(addInput(project, relative, ""), relative).toBeNull();
      expect(sourceProblem(relative), relative).toContain("full path");
    }
    expect(sourceProblem("acme/web")).toBeNull();
    expect(sourceProblem("/home/w/src/api")).toBeNull();
  });

  it("finds a repo's checkout by the hub's path first, and tells the project's own directory", () => {
    const api: ProjectRepo = { repoId: "R2", name: "api", checkout: { machineId: "devbox", projectId: "p9" } };
    expect(checkoutPath(api, [])).toBe("p9");
    expect(checkoutPath({ ...api, path: "/home/w/src/api" }, [])).toBe("/home/w/src/api");
    expect(isOwn(api, project)).toBe(false);
    expect(isOwn({ ...api, checkout: { machineId: "devbox", projectId: "p1" } }, project)).toBe(true);
  });
});
