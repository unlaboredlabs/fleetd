import { describe, expect, it } from "vitest";
import type { ProjectSettings } from "../../../shared/contracts";
import { applied } from "./repoModel";

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
});
