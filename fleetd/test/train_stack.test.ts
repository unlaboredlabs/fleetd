// Stacked PRs through the train: a writer's larger work goes out as a stack, each PR's branch on the one before.
// Whichever is enqueued first, they land in stack order, each as its own squash on main.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectRef } from "../src/shared/contracts.ts";
import { git, Kit, PROJECT, REPO, WS } from "./train_kit.ts";

let kits: Kit[] = [];
afterEach(() => {
  for (const k of kits) k.done();
  kits = [];
});
// Every merge, push and check goes through a real git origin: a loaded machine takes longer than bun's 5 s default.
setDefaultTimeout(30_000);

const kit = () => {
  const k = new Kit();
  kits.push(k);
  return k;
};

const url = (n: number) => `https://github.com/${REPO}/pull/${n}`;

/** A write task's PR #`n` from `branch`, one commit of `files` on top of `on`, into `base`. */
function stacked(k: Kit, n: number, branch: string, on: string, base: string, files: Record<string, string>): void {
  git(k.clone, ["fetch", "-q", "origin"]);
  git(k.clone, ["checkout", "-q", "-B", branch, `origin/${on}`]);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(k.clone, path, ".."), { recursive: true });
    writeFileSync(join(k.clone, path), text);
  }
  git(k.clone, ["add", "-A"]);
  git(k.clone, ["commit", "-q", "-m", `change ${branch}`]);
  git(k.clone, ["push", "-q", "-f", "origin", `${branch}:${branch}`]);
  k.gh.pulls.set(n, { repo: REPO, branch, base, title: `PR ${n}`, body: "", state: "open", merged: false, labels: [], draft: false, comments: [] });
  k.host.tasks.set(`T${n}`, { taskId: `T${n}`, projectRef: PROJECT, workstreamId: WS, kind: "write", state: "done", prUrl: url(n) });
}

const merges = (k: Kit) => k.gh.log.filter((l) => l.startsWith("merge "));

test("a stack of three, each PR based on the branch before, enqueued top first, lands bottom up, each into main", async () => {
  const k = kit();
  stacked(k, 31, "fleetd/T31-schema", "main", "main", { "schema.md": "schema\n" });
  stacked(k, 32, "fleetd/T31-schema-2", "fleetd/T31-schema", "fleetd/T31-schema", { "api.md": "api\n" });
  stacked(k, 33, "fleetd/T31-schema-3", "fleetd/T31-schema-2", "fleetd/T31-schema-2", { "ui.md": "ui\n" });
  await k.enqueue(33);
  await k.enqueue(32);
  await k.enqueue(31);
  // Each waits on the PRs under it, found from its own commits.
  expect(k.change(33).after).toEqual(expect.arrayContaining([url(32), url(31)]));
  expect(k.change(32).after).toEqual([url(31)]);
  await k.settle(30);
  expect([31, 32, 33].map((n) => k.change(n).state)).toEqual(["merged", "merged", "merged"]);
  expect(merges(k)).toEqual(["merge #31", "merge #32", "merge #33"]);
  // Each went into main once the branch under it landed, never into the landed branch.
  expect([31, 32, 33].map((n) => k.gh.pulls.get(n)!.base)).toEqual(["main", "main", "main"]);
  expect(k.mainLog().slice(0, 3)).toEqual(["change fleetd/T31-schema-3 (#33)", "change fleetd/T31-schema-2 (#32)", "change fleetd/T31-schema (#31)"]);
  const files = git(k.origin, ["ls-tree", "--name-only", "main"]).split("\n");
  expect(files).toEqual(expect.arrayContaining(["schema.md", "api.md", "ui.md"]));
});

test("a stacked PR into main whose lower PR is red waits, held on it, and lands once the lower one is fixed", async () => {
  const k = kit();
  stacked(k, 41, "fleetd/T41-core", "main", "main", { "core.md": "core\n", FAIL: "x\n" });
  stacked(k, 42, "fleetd/T41-core-2", "fleetd/T41-core", "main", { "more.md": "more\n" });
  await k.enqueue(42);
  await k.enqueue(41);
  await k.settle(20);
  expect(k.change(41).state).toBe("ci_failed");
  expect(k.change(42).state).not.toBe("merged");
  expect(merges(k)).toEqual([]);
  // The writer fixes the lower PR and rebuilds the one above on it.
  git(k.clone, ["checkout", "-q", "fleetd/T41-core"]);
  git(k.clone, ["rm", "-q", "FAIL"]);
  git(k.clone, ["commit", "-q", "-m", "fix"]);
  git(k.clone, ["push", "-q", "-f", "origin", "fleetd/T41-core:fleetd/T41-core"]);
  git(k.clone, ["checkout", "-q", "fleetd/T41-core-2"]);
  git(k.clone, ["rebase", "-q", "fleetd/T41-core"]);
  git(k.clone, ["push", "-q", "-f", "origin", "fleetd/T41-core-2:fleetd/T41-core-2"]);
  await k.settle(30);
  expect([41, 42].map((n) => k.change(n).state)).toEqual(["merged", "merged"]);
  expect(merges(k)).toEqual(["merge #41", "merge #42"]);
});

/** The train's checkout of the repo on its node, where it rebases a stacked PR whose base landed. */
function checkout(k: Kit): string {
  const dir = join(k.dir, "checkout");
  git(k.dir, ["clone", "-q", k.origin, dir]);
  k.host.checkout = dir;
  return dir;
}

test("a PR stacked on a branch the train rebased and landed moves onto main with only its own commits, and lands", async () => {
  const k = kit();
  checkout(k);
  stacked(k, 51, "fleetd/T51-core", "main", "main", { "core.md": "core\n" });
  // Its base is the lower PR's branch, which the train rewrites when it rebases that PR onto main: GitHub then finds
  // it conflicts with that branch, and runs no CI on it.
  stacked(k, 52, "fleetd/T51-core-2", "fleetd/T51-core", "fleetd/T51-core", { "api.md": "api\n" });
  k.gh.pulls.get(52)!.mergeable = false;
  k.commitMain({ "other.md": "other\n" });
  await k.enqueue(52);
  await k.enqueue(51);
  expect(k.change(52).after).toEqual([url(51)]);
  await k.settle(30);
  expect([51, 52].map((n) => k.change(n).state)).toEqual(["merged", "merged"]);
  expect(k.gh.pulls.get(52)!.base).toBe("main");
  // Rebased past the lower PR's old commit, onto its squash on main.
  expect(git(k.origin, ["rev-parse", "fleetd/T51-core-2^"])).toBe(k.gh.pulls.get(51)!.mergeSha!);
  expect(k.host.nodeRuns.some((argv) => argv[1] === "push" && argv[3]?.startsWith("--force-with-lease=refs/heads/fleetd/T51-core-2:"))).toBe(true);
  expect(k.mainLog().slice(0, 4)).toEqual(["change fleetd/T51-core-2 (#52)", "change fleetd/T51-core (#51)", "main: other.md", "init"]);
  const told = k.host.sends.filter(([id]) => id === "T52").map(([, text]) => text);
  expect(told).toEqual([expect.stringContaining("The merge train moved your PR")]);
  expect(told[0]).toContain("its base fleetd/T51-core landed in #51, so it now goes into main");
});

test("a PR stacked on a landed branch whose own commits conflict with main goes back to its writer, pointed at main", async () => {
  const k = kit();
  checkout(k);
  stacked(k, 61, "fleetd/T61-core", "main", "main", { "core.md": "core\n" });
  stacked(k, 62, "fleetd/T61-core-2", "fleetd/T61-core", "fleetd/T61-core", { "README.md": "the writer's\n" });
  k.gh.pulls.get(62)!.mergeable = false;
  k.commitMain({ "README.md": "main's\n" });
  const head = git(k.origin, ["rev-parse", "fleetd/T61-core-2"]);
  await k.enqueue(62);
  await k.enqueue(61);
  await k.settle(30);
  expect(k.change(61).state).toBe("merged");
  const back = k.change(62);
  expect(back.state).toBe("needs_rebase");
  expect(back.lastError).toContain("conflicts with main in README.md once the train pointed it there (its base fleetd/T61-core landed in #61)");
  expect(k.gh.pulls.get(62)!.base).toBe("main");
  // Nothing pushed over the writer's branch.
  expect(git(k.origin, ["rev-parse", "fleetd/T61-core-2"])).toBe(head);
  const told = k.host.sends.filter(([id]) => id === "T62").map(([, text]) => text);
  expect(told.length).toBe(1);
  expect(told[0]).toContain(`git rebase --onto origin/main ${git(k.origin, ["rev-parse", "fleetd/T61-core"])}`);
});

test("a writer's push during the train's rebase of its stacked PR is never pushed over", async () => {
  const k = kit();
  checkout(k);
  stacked(k, 71, "fleetd/T71-core", "main", "main", { "core.md": "core\n" });
  stacked(k, 72, "fleetd/T71-core-2", "fleetd/T71-core", "fleetd/T71-core", { "api.md": "api\n" });
  k.gh.pulls.get(72)!.mergeable = false;
  k.commitMain({ "other.md": "other\n" });
  // The writer pushes again just before the train's rebased head would go out.
  const run = k.host.nodeRun.bind(k.host);
  k.host.nodeRun = async (c: ProjectRef, cwd: string, argv: string[]) => {
    if (argv[1] === "push" && argv.some((a) => a.includes("fleetd/T71-core-2"))) {
      git(k.clone, ["checkout", "-q", "fleetd/T71-core-2"]);
      writeFileSync(join(k.clone, "late.md"), "late\n");
      git(k.clone, ["add", "-A"]);
      git(k.clone, ["commit", "-q", "-m", "late"]);
      git(k.clone, ["push", "-q", "origin", "fleetd/T71-core-2:fleetd/T71-core-2"]);
    }
    return run(c, cwd, argv);
  };
  await k.enqueue(72);
  await k.enqueue(71);
  await k.settle(30);
  // The train's lease on the head it saw refused its push: the writer's commit went through as any push does.
  expect(k.host.nodeRuns.some((argv) => argv[1] === "push")).toBe(true);
  expect(k.host.sends.filter(([id, text]) => id === "T72" && text.includes("pushed"))).toEqual([]);
  expect(k.gh.pulls.get(72)!.base).toBe("main");
  expect(k.change(72).state).toBe("merged");
  expect(git(k.origin, ["ls-tree", "--name-only", "main"]).split("\n")).toEqual(expect.arrayContaining(["api.md", "late.md"]));
});
