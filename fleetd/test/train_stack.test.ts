// Stacked PRs through the train: a writer's larger work goes out as a stack, each PR's branch on the one before.
// Whichever is enqueued first, they land in stack order, each as its own squash on main.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
