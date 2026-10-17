// The branch diff script over real git in a temp repo, run the way a node runs it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MachineId } from "@fleetd/contracts";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";
import { localCommands } from "../train/localCommands.ts";
import { branchDiff } from "./branchDiff.ts";

const ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  LANG: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...argv: ReadonlyArray<string>) => execFileSync("git", argv, { cwd, env: ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const commit = (cwd: string, file: string, message: string) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), `${message}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", message);
};

/** A bare origin and a checkout of it on main with one commit; the task branch is cut from there. */
const repo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-branch-diff-"));
  dirs.push(dir);
  const origin = path.join(dir, "origin.git");
  const root = path.join(dir, "checkout");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, root);
  git(root, "checkout", "-qb", "main");
  commit(root, "README.md", "init");
  git(root, "push", "-q", "origin", "main");
  git(root, "branch", "-q", "fleetd/T1-add-file");
  return root;
};

const diff = (root: string, branch = "fleetd/T1-add-file") =>
  Effect.runPromise(branchDiff(localCommands(ENV), { machineId: "lab-a" as MachineId, cwd: root, base: "main", branch }));

describe("branchDiff", () => {
  it("names only the branch's own files after it rebased onto a newer origin/main", async () => {
    const root = repo();
    // Someone else's merge lands on origin/main.
    const other = path.join(path.dirname(root), "other");
    git(path.dirname(root), "clone", "-q", path.join(path.dirname(root), "origin.git"), other);
    commit(other, "src/main-only.ts", "theirs");
    git(other, "push", "-q", "origin", "main");
    // The writer commits on its branch, fetches and rebases onto origin/main; the local main stays behind.
    git(root, "checkout", "-q", "fleetd/T1-add-file");
    commit(root, "docs/x.md", "mine");
    git(root, "fetch", "-q", "origin");
    git(root, "rebase", "-q", "origin/main");
    git(root, "checkout", "-q", "main");
    expect(await diff(root)).toEqual(["docs/x.md"]);
  });

  it("uses the local base when there is no newer origin, and says nothing for an unknown branch", async () => {
    const root = repo();
    git(root, "checkout", "-q", "fleetd/T1-add-file");
    commit(root, "docs/x.md", "mine");
    git(root, "rm", "-q", "README.md");
    git(root, "commit", "-qm", "drop readme");
    git(root, "checkout", "-q", "main");
    commit(root, "src/local.ts", "local main moved on");
    expect(await diff(root)).toEqual(["README.md", "docs/x.md"]);
    expect(await diff(root, "fleetd/T9-nope")).toBeUndefined();
    expect(await diff(root, "--upload-pack=x")).toBeUndefined();
  });
});
