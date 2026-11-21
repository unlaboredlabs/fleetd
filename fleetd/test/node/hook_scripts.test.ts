// What the node writes for a writer's hooks is what the pure hook_scripts.ts says to write, byte for byte, so a hosted
// box that writes those files from it (fleetd/box/hook_scripts) gets the node's hooks.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateFiles, trailerFiles, type HookFile } from "../../src/node/worktree/hook_scripts.ts";
import { gate, trailerHooks } from "../../src/node/worktree/hooks.ts";
import * as setup from "../../src/node/worktree/setup.ts";
import * as words from "../../src/node/worktree/setup_words.ts";
import { tempHome } from "../helpers.ts";

const git = (cwd: string, args: string[]) => spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });

/** Every file under `dir`, with its text and mode. */
const written = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort()
    .map((path) => ({ path, text: readFileSync(path, "utf8"), mode: statSync(path).mode & 0o777 }));
const asHooks = (files: HookFile[]) => files.map((f) => ({ ...f, mode: 0o755 })).sort((a, b) => a.path.localeCompare(b.path));

test("the trailer hooks and the gate a worktree gets are the files the pure functions return", async () => {
  const home = tempHome();
  try {
    const repo = join(home.dir, "repo");
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
    git(repo, ["config", "extensions.worktreeConfig", "true"]);
    // One hot hook the repo has: it is forwarded, the other isn't.
    writeFileSync(join(repo, ".git/hooks/reference-transaction"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(repo, ".git/hooks/reference-transaction"), 0o755);
    const wt = join(home.dir, "wt's");
    git(repo, ["worktree", "add", "-q", "-b", "fleetd/T42-x", wt]);
    const gitDir = realpathSync(git(wt, ["rev-parse", "--absolute-git-dir"]).stdout.trim());

    expect(await trailerHooks(wt, "T42")).toBe(true);
    const trailer = trailerFiles(gitDir, "T42", ["reference-transaction"]);
    expect(git(wt, ["config", "--worktree", "core.hooksPath"]).stdout.trim()).toBe(trailer.dir);
    expect(written(trailer.dir)).toEqual(asHooks(trailer.files));
    expect(trailer.files.some((f) => f.path.endsWith("/reference-transaction"))).toBe(true);
    expect(trailer.files.some((f) => f.path.endsWith("/post-index-change"))).toBe(false);

    const env: Record<string, string> = {};
    await gate(wt, env);
    const pushed = gateFiles(gitDir, ["reference-transaction"]);
    expect(written(join(gitDir, "fleetd-push"))).toEqual(
      [...asHooks(pushed.files), { ...pushed.config, mode: statSync(pushed.config.path).mode & 0o777 }].sort((a, b) => a.path.localeCompare(b.path)),
    );
    expect(env).toEqual({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: pushed.include[0], GIT_CONFIG_VALUE_0: pushed.include[1] });
  } finally {
    home.done();
  }
});

test("a git dir with a line break has no gate", () => {
  expect(() => gateFiles("/a\nb", [])).toThrow("has a line break");
});

test("setup.ts's words are setup_words.ts's", () => {
  expect([setup.note, setup.how, setup.timeoutOf, setup.SETUP_TIMEOUT_SEC]).toEqual([words.note, words.how, words.timeoutOf, words.SETUP_TIMEOUT_SEC]);
});
