// The node's patch-id command against real git: a clean rebase keeps the patch id, a changed diff changes it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parsePatchId, patchIdArgv } from "./PatchIds.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-patch-id-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const env = {
  PATH: process.env.PATH ?? "",
  HOME: root,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: ReadonlyArray<string>) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (dir: string, file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);

const patchId = (cwd: string, sha: string) => {
  const argv = patchIdArgv({ base: "main", prNumber: 1, sha });
  if (typeof argv === "string") throw new Error(argv);
  const [command, ...args] = argv;
  return parsePatchId(execFileSync(command!, args, { cwd, env, encoding: "utf8" }));
};

describe("patch ids", () => {
  it("survive a clean rebase onto a moved base and change with the diff", () => {
    const origin = path.join(root, "origin.git");
    const author = path.join(root, "author");
    const project = path.join(root, "project");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "clone", "-q", origin, author);
    write(author, "a.txt", "one\n");
    write(author, "b.txt", "base\n");
    git(author, "add", ".");
    git(author, "commit", "-q", "-m", "base");
    git(author, "push", "-q", "origin", "HEAD:main");
    git(root, "clone", "-q", origin, project);

    git(author, "checkout", "-q", "-b", "pr");
    write(author, "a.txt", "one\ntwo\n");
    git(author, "commit", "-q", "-am", "the change");
    const first = git(author, "rev-parse", "HEAD");
    git(author, "push", "-q", "origin", "HEAD:refs/pull/1/head");
    const p1 = patchId(project, first);
    expect(p1).toMatch(/^[0-9a-f]{40}$/u);

    // main moves in another file; the PR is rebased onto it cleanly.
    git(author, "checkout", "-q", "main");
    write(author, "b.txt", "base\nmore\n");
    git(author, "commit", "-q", "-am", "unrelated");
    git(author, "push", "-q", "origin", "HEAD:main");
    git(author, "checkout", "-q", "pr");
    git(author, "rebase", "-q", "main");
    const rebased = git(author, "rev-parse", "HEAD");
    git(author, "push", "-q", "-f", "origin", "HEAD:refs/pull/1/head");
    expect(rebased).not.toBe(first);
    expect(patchId(project, rebased)).toBe(p1);

    write(author, "a.txt", "one\ntwo\nthree\n");
    git(author, "commit", "-q", "-am", "review fix");
    const fixed = git(author, "rev-parse", "HEAD");
    git(author, "push", "-q", "origin", "HEAD:refs/pull/1/head");
    expect(patchId(project, fixed)).not.toBe(p1);
  });

  it("refuses inputs that are not a SHA, a branch name or a PR number", () => {
    expect(patchIdArgv({ base: "main", prNumber: 1, sha: "HEAD" })).toBe("not a full commit SHA: HEAD");
    expect(patchIdArgv({ base: "../x", prNumber: 1, sha: "a".repeat(40) })).toBe("not a branch name: ../x");
    expect(patchIdArgv({ base: "main", prNumber: 0, sha: "a".repeat(40) })).toBe("not a PR number: 0");
    expect(parsePatchId("")).toBeUndefined();
  });
});
