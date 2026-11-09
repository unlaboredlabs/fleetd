// A review worktree at its PR's head, and a token-marked checkout's remote calls with its order's token
// (worktree.rs's own cases): a PR's number and repo from any host's URL, the head fetched from the PR's remote when
// this machine lacks it, and the token only in git's environment, only for github.com.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { gitRemote, prHead, prNumber, prRepo, remoteEnv, remoteRepo, TOKEN_MARK, useToken } from "../../src/node/worktree/index.ts";
import { tempHome } from "../helpers.ts";

const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
const repo = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
};

test("a pr number is read from any host's url", () => {
  for (const [url, n] of [
    ["https://github.com/o/r/pull/7", 7],
    ["https://github.com/o/r/pull/7/files#diff", 7],
    ["https://gitea.example.com/o/r/pulls/12", 12],
    ["https://gitlab.com/g/sub/r/-/merge_requests/8/diffs", 8],
    ["https://bitbucket.org/o/r/pull-requests/3?tab=diff", 3],
    ["https://git.example.com/o/r/commit/abc", undefined],
  ] as const)
    expect(prNumber(url)).toBe(n);
});

test("a pr's repo and a remote's are read from any host's urls", () => {
  for (const [url, r] of [
    ["https://github.com/O/R/pull/7/files", "github.com/o/r"],
    ["https://gitlab.com/g/sub/r/-/merge_requests/8", "gitlab.com/g/sub/r"],
    ["https://bitbucket.org/o/r/pull-requests/3", "bitbucket.org/o/r"],
    ["https://github.com/o/r/commit/abc", undefined],
  ] as const)
    expect(prRepo(url)).toBe(r);
  for (const [url, r] of [
    ["https://github.com/o/r.git", "github.com/o/r"],
    ["https://user@github.com/o/r/", "github.com/o/r"],
    ["git@github.com:o/r.git", "github.com/o/r"],
    ["ssh://git@gitlab.com:2222/g/sub/r.git", "gitlab.com/g/sub/r"],
    ["/srv/git/r.git", undefined],
  ] as const)
    expect(remoteRepo(url)).toBe(r);
});

test("a review's head is fetched from the pr's remote into the object store alone", async () => {
  const home = tempHome();
  try {
    const writer = repo(join(home.dir, "writer"));
    const origin = join(home.dir, "origin.git");
    spawnSync("git", ["clone", "-q", "--bare", writer, origin]);
    git(writer, "commit", "-q", "--allow-empty", "-m", "the pr");
    const sha = git(writer, "rev-parse", "HEAD").stdout.trim();
    git(writer, "push", "-q", origin, "HEAD:refs/pull/7/head");
    const reader = join(home.dir, "reader");
    spawnSync("git", ["clone", "-q", "--no-local", origin, reader]);
    // Its URL is the PR's repo; git connects to the bare one through insteadOf.
    git(reader, "remote", "set-url", "origin", "https://github.com/acme/shop.git");
    git(reader, "config", `url.${origin}.insteadOf`, "https://github.com/acme/shop.git");
    expect(git(reader, "cat-file", "-e", sha).status).not.toBe(0);
    expect(await prHead(reader, "https://github.com/acme/shop/pull/7")).toBe(sha);
    expect(git(reader, "cat-file", "-e", sha).status).toBe(0);
    expect(git(reader, "for-each-ref", "refs/pull").stdout).toBe("");
    await expect(prHead(reader, "https://github.com/acme/other/pull/7")).rejects.toThrow("no remote is github.com/acme/other");
    await expect(prHead(reader, "https://github.com/acme/shop/pull/8")).rejects.toThrow("origin publishes no ref for PR 8");
  } finally {
    home.done();
  }
});

/** A checkout fleetd cloned with a token (a cloud machine's, D306) authenticates its remote calls with the newest real
 * token an order's launch brought, and git sees it only for github.com, only through the environment. */
test("only a checkout cloned with a token fetches with its order's token", async () => {
  const home = tempHome();
  try {
    const plain = repo(join(home.dir, "plain"));
    const cloud = repo(join(home.dir, "cloud"));
    git(cloud, "config", TOKEN_MARK, "true");
    useToken(plain, "ghs_one");
    useToken(cloud, "ghs_one");
    // A placeholder for a token taken back never replaces the last real one.
    useToken(cloud, "fleetd-github-not-connected-connect-it-in-settings");
    const header = async (root: string, url: string) => (await gitRemote(root, ["config", "--get-urlmatch", "http.extraheader", url], 10_000).catch(() => "")).trim();
    const basic = (t: string) => `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${t}`).toString("base64")}`;
    expect(await header(cloud, "https://github.com/acme/shop")).toBe(basic("ghs_one"));
    expect(await header(cloud, "https://gitlab.example.com/acme/shop")).toBe("");
    expect(await header(plain, "https://github.com/acme/shop")).toBe("");
    expect(remoteEnv(plain)).toEqual({});
    // Never in the checkout's own config.
    expect(git(cloud, "config", "--get-all", "http.https://github.com/.extraheader").status).not.toBe(0);
    // A newer token replaces it.
    useToken(cloud, "ghs_two");
    expect(await header(cloud, "https://github.com/acme/shop")).toBe(basic("ghs_two"));
  } finally {
    home.done();
  }
});
