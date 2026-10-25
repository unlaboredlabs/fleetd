// The factory lab's project: not fleetd, generated at run time. A small Python package whose test command takes a few
// seconds, a bare origin on a self-hosted ssh git server that isn't GitHub, `main` as its default branch, and no
// `.fleetd/`. The server is a stand-in for ssh (each clone's `core.sshCommand`) that runs git's command against the bare
// repo here, so `git remote get-url origin` says ssh://git@git.lab.invalid/… and nothing touches the network. Two clones:
// - `root`, the checkout on the lab machine that fleetd's project points at;
// - `human`, the person's own checkout elsewhere: they push to main from it and merge PRs outside fleetd.
// With no GitHub, "a PR merged outside fleetd" is what the landing scanner reads from git alone: a merge (or squash)
// commit on main whose message is the host's default merge message, and the PR's branch deleted on the remote.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The origin's URL as fleetd sees it: a self-hosted git server, not GitHub. */
export const ORIGIN_URL = "ssh://git@git.lab.invalid/acme/inventory.git";
export const BASE = "main";
/** The project's own test command (a few seconds: one test waits on a slow supplier). */
export const TEST_COMMAND = "python3 -m unittest discover -s tests";

const HUMAN = { name: "lab human", email: "human@lab.invalid" };

const SEED: Readonly<Record<string, string>> = {
  "README.md": `# inventory

Stock levels for a small shop. Tests: \`${TEST_COMMAND}\`.
`,
  "inventory/__init__.py": "",
  "inventory/stock.py": `class Stock:
    def __init__(self):
        self.levels = {}

    def add(self, sku, qty):
        if qty <= 0:
            raise ValueError("qty must be positive")
        self.levels[sku] = self.levels.get(sku, 0) + qty

    def take(self, sku, qty):
        have = self.levels.get(sku, 0)
        if qty > have:
            raise ValueError(f"only {have} of {sku}")
        self.levels[sku] = have - qty
`,
  "inventory/supplier.py": `import time


def quote(sku):
    """A slow supplier: every quote takes a second."""
    time.sleep(1)
    return {"sku": sku, "price": 3}
`,
  "tests/test_stock.py": `import unittest

from inventory.stock import Stock


class StockTest(unittest.TestCase):
    def test_add_then_take(self):
        s = Stock()
        s.add("apple", 3)
        s.take("apple", 2)
        self.assertEqual(s.levels["apple"], 1)

    def test_take_too_many(self):
        s = Stock()
        with self.assertRaises(ValueError):
            s.take("pear", 1)
`,
  "tests/test_supplier.py": `import unittest

from inventory.supplier import quote


class SupplierTest(unittest.TestCase):
    def test_quotes(self):
        for sku in ("apple", "pear", "plum"):
            self.assertEqual(quote(sku)["price"], 3)
`,
  ".gitignore": "__pycache__/\n",
};

export const git = (cwd: string, ...args: Array<string>) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: HUMAN.name,
      GIT_AUTHOR_EMAIL: HUMAN.email,
      GIT_COMMITTER_NAME: HUMAN.name,
      GIT_COMMITTER_EMAIL: HUMAN.email,
    },
  }).trim();

const write = (dir: string, files: Readonly<Record<string, string>>) => {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
};

/**
 * A checkout's state as a person would notice it: every file outside .git byte for byte, HEAD, tags and their own
 * branches. Task branches (`fleetd/…`) are fleetd's: its worktrees share the checkout's refs.
 */
export const checkoutState = (dir: string): Record<string, string> => {
  const state: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const name = path.join(rel, entry.name);
      if (name === ".git") continue;
      if (entry.isDirectory()) walk(name);
      else if (entry.isSymbolicLink()) state[name] = `-> ${fs.readlinkSync(path.join(dir, name))}`;
      else state[name] = createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex");
    }
  };
  walk("");
  state["git:HEAD"] = git(dir, "symbolic-ref", "-q", "HEAD");
  state["git:refs"] = git(dir, "for-each-ref", "--format=%(refname) %(objectname)", "--exclude=refs/heads/fleetd/**", "refs/heads", "refs/tags");
  state["git:stash"] = git(dir, "stash", "list", "--format=%H");
  return state;
};

/** Every byte under `dir`, `.git` included: for a checkout nothing but its owner may touch. */
export const treeBytes = (dir: string): Record<string, string> => {
  const state: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const name = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (entry.isSymbolicLink()) state[name] = `-> ${fs.readlinkSync(path.join(dir, name))}`;
      else state[name] = createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex");
    }
  };
  walk("");
  return state;
};

/** The paths whose bytes differ between two states, each marked + (new), - (gone) or ~ (changed). */
export const stateDiff = (before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => before[k] !== after[k])
    .map((k) => `${before[k] === undefined ? "+" : after[k] === undefined ? "-" : "~"} ${k}`)
    .toSorted();

export interface Project {
  /** The bare repo the origin URL resolves to. */
  readonly bare: string;
  /** The lab machine's checkout: the fleetd project's root. */
  readonly root: string;
  /** The person's own checkout. */
  readonly human: string;
  /** origin's main, read from the bare repo. */
  readonly originMain: () => string;
  /** The person commits `files` on main in their checkout and pushes it straight to origin; returns the commit. */
  readonly pushAsHuman: (subject: string, files: Readonly<Record<string, string>>) => string;
  /**
   * A PR opened and merged outside fleetd, in the person's checkout: its branch pushed, then merged into main as the
   * host would (a merge commit with the host's merge message, or a squash ending in `(#n)`) and the branch deleted on
   * origin. Returns the commit that landed on main.
   */
  readonly mergeOutside: (pr: OutsidePr) => string;
}

export interface OutsidePr {
  readonly number: number;
  readonly branch: string;
  readonly title: string;
  readonly files: Readonly<Record<string, string>>;
  /** gitlab (the default: the origin isn't GitHub): "Merge branch … See merge request acme/inventory!n"; github: "Merge pull request #n from acme/branch"; squash: "title (#n)". */
  readonly style?: "gitlab" | "github" | "squash";
}

/**
 * Generates the project under `dir`: the git server's bare origin with the seed on main, and both clones of it. Each
 * clone reaches the server through its own config; the node's worktrees share the root's.
 */
export const createProject = (dir: string): Project => {
  const server = path.join(dir, "git-server");
  const bare = path.join(server, new URL(ORIGIN_URL).pathname);
  const root = path.join(dir, "machine/inventory");
  const human = path.join(dir, "human/inventory");
  // `ssh [-o …] host command`, where git's command is `git-upload-pack '/acme/inventory.git'` (or receive-pack): run
  // it as `git upload-pack '<server>/acme/inventory.git'`. `ssh.variant=simple`, so git passes no ssh options.
  const ssh = path.join(server, "ssh");
  fs.mkdirSync(server, { recursive: true });
  fs.writeFileSync(
    ssh,
    `#!/bin/sh
while [ $# -gt 2 ]; do shift; done
exec sh -c "$(printf '%s' "$2" | sed -e "s|^git-|git |" -e "s|'/|'${server}/|")"
`,
    { mode: 0o755 },
  );
  const reach = [`core.sshCommand=${ssh}`, "ssh.variant=simple"];

  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(path.dirname(bare), "init", "-q", "--bare", "-b", BASE, bare);
  const seed = path.join(dir, "seed");
  fs.mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", BASE);
  write(seed, SEED);
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "inventory: stock and a slow supplier, with tests");
  git(seed, "push", "-q", bare, `${BASE}:${BASE}`);
  fs.rmSync(seed, { recursive: true, force: true });

  for (const clone of [root, human]) {
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    git(path.dirname(clone), ...reach.flatMap((c) => ["-c", c]), "clone", "-q", ...reach.flatMap((c) => ["--config", c]), ORIGIN_URL, clone);
    git(clone, "config", "user.name", HUMAN.name);
    git(clone, "config", "user.email", HUMAN.email);
  }

  const pushAsHuman = (subject: string, files: Readonly<Record<string, string>>) => {
    git(human, "checkout", "-q", BASE);
    git(human, "pull", "-q", "--ff-only", "origin", BASE);
    write(human, files);
    git(human, "add", ...Object.keys(files));
    git(human, "commit", "-q", "-m", subject);
    git(human, "push", "-q", "origin", `${BASE}:${BASE}`);
    return git(human, "rev-parse", "HEAD");
  };

  const mergeOutside = (pr: OutsidePr) => {
    const style = pr.style ?? "gitlab";
    git(human, "checkout", "-q", BASE);
    git(human, "pull", "-q", "--ff-only", "origin", BASE);
    git(human, "checkout", "-q", "-b", pr.branch);
    write(human, pr.files);
    git(human, "add", ...Object.keys(pr.files));
    git(human, "commit", "-q", "-m", pr.title);
    git(human, "push", "-q", "origin", pr.branch);
    git(human, "checkout", "-q", BASE);
    if (style === "squash") {
      git(human, "merge", "-q", "--squash", pr.branch);
      git(human, "commit", "-q", "-m", `${pr.title} (#${pr.number})`);
    } else {
      const message =
        style === "github"
          ? `Merge pull request #${pr.number} from acme/${pr.branch}\n\n${pr.title}`
          : `Merge branch '${pr.branch}' into '${BASE}'\n\n${pr.title}\n\nSee merge request acme/inventory!${pr.number}`;
      git(human, "merge", "-q", "--no-ff", "-m", message, pr.branch);
    }
    git(human, "push", "-q", "origin", BASE, `:${pr.branch}`);
    git(human, "branch", "-q", "-D", pr.branch);
    return git(human, "rev-parse", "HEAD");
  };

  return { bare, root, human, originMain: () => git(bare, "rev-parse", BASE), pushAsHuman, mergeOutside };
};
