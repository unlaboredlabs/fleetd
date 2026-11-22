// Where a writer's branch starts when its fetch fails: a lock race with another git in the same checkout (a fetch beside
// the node's) is run again and never blamed on access or the network; only git's own words name the network or a login.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchError, freshBase, LOCK_RETRY_MS } from "../../src/node/worktree/index.ts";
import { tempHome } from "../helpers.ts";

const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });

/** An origin, a checkout of it, and a commit on origin the checkout hasn't fetched yet. */
function rig(dir: string) {
  const origin = join(dir, "origin");
  const root = join(dir, "root");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  git(origin, "commit", "-q", "--allow-empty", "-m", "one");
  git(dir, "clone", "-q", origin, root);
  git(origin, "commit", "-q", "--allow-empty", "-m", "two");
  const head = git(origin, "rev-parse", "HEAD").stdout.trim();
  // What git leaves while another fetch in the checkout updates origin/main.
  const lock = join(root, ".git", "refs", "remotes", "origin", "main.lock");
  mkdirSync(join(lock, ".."), { recursive: true });
  writeFileSync(lock, "");
  return { root, head, lock };
}

test("a fetch that loses a lock race runs again and starts from the fresh base", async () => {
  const home = tempHome();
  try {
    const { root, head, lock } = rig(home.dir);
    const slept: number[] = [];
    const base = await freshBase(root, "main", async (ms) => {
      slept.push(ms);
      // The other git finishes during the wait.
      if (slept.length === 2) rmSync(lock);
    });
    expect(slept).toEqual(LOCK_RETRY_MS);
    expect(base).toMatchObject({ baseRef: "origin/main", sha: head });
    expect(base.error).toBeUndefined();
  } finally {
    home.done();
  }
});

test("a lock that outlasts every try fails the fetch with git's words, not as offline or a login", async () => {
  const home = tempHome();
  try {
    const { root, head } = rig(home.dir);
    const slept: number[] = [];
    const base = await freshBase(root, "main", async (ms) => void slept.push(ms));
    expect(slept).toEqual(LOCK_RETRY_MS);
    expect(base.sha).not.toBe(head);
    expect(base.error?.kind).toBe("failed");
    // Git's line naming the lock (older git: "cannot lock ref"), not the "From …" line before it.
    expect(base.error?.message).toMatch(/reference already exists|cannot lock ref/);
  } finally {
    home.done();
  }
});

test("why a fetch failed: the network and logins only for their own words", () => {
  const kind = (text: string) => fetchError(`git fetch failed: ${text}`).kind;
  expect(kind("error: cannot lock ref 'refs/remotes/origin/main': is at 1111111 but expected 2222222")).toBe("failed");
  expect(kind("fatal: incorrect old value provided")).toBe("failed");
  expect(kind("From github.com:a/b\nerror: fetching ref refs/remotes/origin/main failed: reference already exists")).toBe("failed");
  expect(kind(" ! 1111111..2222222  main -> origin/main  (unable to update local ref)")).toBe("failed");
  expect(kind("fatal: Unable to create '/w/shop/.git/index.lock': File exists.\n\nAnother git process seems to be running")).toBe("failed");
  expect(kind("ssh: connect to host github.com port 22: Connection timed out\nfatal: Could not read from remote repository.")).toBe("offline");
  expect(kind("Connection closed by 1.2.3.4 port 22\nfatal: Could not read from remote repository.")).toBe("offline");
  expect(kind("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.")).toBe("auth");
  expect(kind("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe("auth");
  expect(kind("ERROR: Repository not found.\nfatal: Could not read from remote repository.")).toBe("no_access");
  expect(kind("error: cannot run ssh: No such file or directory")).toBe("no_ssh");
  expect(fetchError("git fetch failed: From github.com:a/b\nerror: fetching ref refs/remotes/origin/main failed: incorrect old value provided").message).toBe(
    "error: fetching ref refs/remotes/origin/main failed: incorrect old value provided",
  );
});
