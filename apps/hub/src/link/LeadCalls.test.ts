import { MachineId, ProjectId, type ProjectSummary } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { outsideEveryProject, projectForCwd } from "./LeadCalls.ts";

const LAB = MachineId.make("lab-a");

const project = (projectId: string, workspaceRoot: string): ProjectSummary => ({
  machineId: LAB,
  projectId: ProjectId.make(projectId),
  title: projectId,
  workspaceRoot,
  threads: { running: 0, waiting: 0, idle: 0, failed: 0 },
  lastActivityAt: "2026-10-17T10:00:00.000Z",
});

const resolve = (projects: ReadonlyArray<ProjectSummary>, cwd: string) => projectForCwd(projects, cwd)?.projectId;

describe("projectForCwd", () => {
  const projects = [project("ab", "/a/b"), project("abc", "/a/bc"), project("nested", "/a/b/tools/sub")];

  it("matches the root itself and anything under it, including worktrees", () => {
    expect(resolve(projects, "/a/b")).toBe("ab");
    expect(resolve(projects, "/a/b/src")).toBe("ab");
    expect(resolve(projects, "/a/b/.t3/worktrees/w12/apps")).toBe("ab");
  });

  it("does not treat a sibling sharing a name prefix as inside", () => {
    expect(resolve(projects, "/a/bc")).toBe("abc");
    expect(resolve(projects, "/a/bcd")).toBeUndefined();
    expect(resolve([project("ab", "/a/b")], "/a/bc/x")).toBeUndefined();
  });

  it("refuses parents and unrelated paths", () => {
    expect(resolve(projects, "/a")).toBeUndefined();
    expect(resolve(projects, "/")).toBeUndefined();
    expect(resolve(projects, "/elsewhere")).toBeUndefined();
  });

  it("prefers the deepest of nested roots", () => {
    expect(resolve(projects, "/a/b/tools/sub/x")).toBe("nested");
    expect(resolve(projects, "/a/b/tools")).toBe("ab");
  });

  it("compares lexically normalized paths, so trailing slashes and dot segments do not matter", () => {
    expect(resolve([project("ab", "/a/b/")], "/a/b")).toBe("ab");
    expect(resolve(projects, "/a/b/src/")).toBe("ab");
    expect(resolve(projects, "/a//b/./src")).toBe("ab");
    // `..` cannot climb out of a root and still match it.
    expect(resolve(projects, "/a/b/../bc/x")).toBe("abc");
    expect(resolve(projects, "/a/b/../x")).toBeUndefined();
  });

  it("keeps symlinked roots as written: a root through a link matches the logical path, not the target", () => {
    const linked = [project("link", "/home/me/proj")];
    expect(resolve(linked, "/home/me/proj/src")).toBe("link");
    expect(resolve(linked, "/data/proj/src")).toBeUndefined();
  });

  it("ignores relative roots and lets a root of / hold everything", () => {
    expect(resolve([project("rel", "a/b")], "/a/b")).toBeUndefined();
    expect(resolve([project("root", "/")], "/anything/here")).toBe("root");
  });
});

describe("outsideEveryProject", () => {
  it("lists where the lead can run from, capped at five roots", () => {
    const many = Array.from({ length: 7 }, (_, i) => project(`p${i}`, `/src/p${i}`));
    expect(outsideEveryProject(LAB, "/tmp", many)).toMatchObject({
      code: "forbidden",
      message: "/tmp is not inside any project workspace on lab-a",
      fix: "run fleetd from the project's workspace or a worktree under it (/src/p0, /src/p1, /src/p2, /src/p3, /src/p4 and 2 more)",
    });
  });

  it("says when the hub has seen no projects on the machine yet", () => {
    expect(outsideEveryProject(LAB, "/src/api", []).fix).toBe("check that T3 is up on lab-a (fleetd_status), then run the command again");
  });
});
