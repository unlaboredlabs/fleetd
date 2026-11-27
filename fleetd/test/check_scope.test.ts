// scripts/check.sh's pick (fleetd/scripts/check_scope.ts): the parts and the fleetd tests a change reaches, run more
// when it can't tell, and an earlier pass that still counts after a clean merge of a newer main that touched none of
// the change's files, and only then.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { partsFor, plan, readPasses, shell, since, testsFor, type Pass } from "../scripts/check_scope.ts";
import { tempHome } from "./helpers.ts";

describe("the parts a change reaches, in this repo", () => {
  test("a phone-only change runs none of them: CI's fleetd, site and desktop jobs don't run for it either", () => {
    expect(partsFor(["app/mobile/src/screens/dms/Dms.tsx"])).toEqual({});
  });

  test("a change in one area of fleetd runs the tests that reach it, not the others, and the site but its layout check", () => {
    const parts = partsFor(["fleetd/src/node/browser/chrome.ts"]);
    expect(parts.site).toBe("help");
    expect(parts.desktop).toBeUndefined();
    const tests = parts.fleetd as string[];
    expect(tests).toContain("test/node-browser.test.ts");
    expect(tests).not.toContain("test/vault_crypto.test.ts");
  });

  test("a test's own change runs it", () => {
    expect(testsFor(["fleetd/test/vault_crypto.test.ts"])).toContain("test/vault_crypto.test.ts");
  });

  test("shared code runs everything that reads it: the wire contract reaches fleetd's tests, desktop and the site", () => {
    const parts = partsFor(["app/desktop/src/shared/contracts/contracts.ts"]);
    expect(parts.desktop).toBe(true);
    expect(parts.site).toBe("help");
    const tests = parts.fleetd as string[];
    expect(tests).toContain("test/contracts.test.ts");
    expect(tests).toContain("test/app-ws.test.ts");
  });

  test("what every test reads, and what no test names, run every test", () => {
    for (const path of ["fleetd/bun.lock", "fleetd/package.json", "fleetd/test/preload.ts"]) expect(testsFor([path])).toBe("all");
    // A deleted file: who read it can't be told.
    expect(testsFor(["fleetd/src/hub/gone_since.ts"])).toBe("all");
  });

  test("the site's own files build it; the renderer's run desktop and its screens", () => {
    expect(partsFor(["docs/site/src/content/docs/agent-time.md"]).site).toBe("full");
    const parts = partsFor(["app/desktop/src/renderer/screens/activity/ActivityPane.tsx"]);
    expect(parts.desktop).toBe(true);
    expect(parts.qa).toEqual(["src/renderer/screens/activity/ActivityPane.tsx"]);
    expect(parts.fleetd).toBeUndefined();
  });

  test("the hub files the desktop's tests read run desktop, as ci.yml's desktop scope does", () => {
    expect(partsFor(["fleetd/src/hub/app_ws/server.ts"]).desktop).toBe(true);
  });
});

describe("an earlier pass, after main moved", () => {
  const home = tempHome();
  afterAll(() => home.done());
  const repo = join(home.dir, "repo");
  const git = (...args: string[]) => {
    const out = spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
    if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
    return out.stdout.trim();
  };
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  };
  const commit = (files: Record<string, string>, message = "change") => {
    write(files);
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const treeOf = (rev: string) => git("rev-parse", `${rev}^{tree}`);
  const lines = (n: number, edit?: [number, string]) =>
    Array.from({ length: n }, (_, i) => (edit?.[0] === i ? edit[1] : `line ${i}`)).join("\n") + "\n";

  // A tiny repo: fleetd's scope is fleetd/, two tests each reaching one source, and a desktop file.
  mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  const main0 = commit({
    ".github/fleetd-scope.sh": "#!/usr/bin/env bash\npaths=(\n  fleetd\n)\n",
    "fleetd/src/a.ts": lines(20),
    "fleetd/src/b.ts": lines(20),
    "fleetd/test/a.test.ts": 'import "../src/a.ts";\n',
    "fleetd/test/b.test.ts": 'import "../src/b.ts";\n',
    "app/desktop/x.ts": lines(5),
    "README.md": "fleetd\n",
  });
  // The PR: an edit to a.ts, passed on its tree.
  git("checkout", "-q", "-b", "pr");
  const pr = commit({ "fleetd/src/a.ts": lines(20, [2, "the PR's line"]) });
  const passed: Pass = { tree: treeOf(pr), base: main0, check: "fleetd" };
  // A fleetd change runs the site's check against `fleetd help` too: it passed beside it.
  const passes: Pass[] = [passed, { ...passed, check: "site" }];

  /** Main from main0 with these files, and the PR rebased onto it (or the conflict). */
  const moved = (files: Record<string, string>) => {
    git("checkout", "-q", "-B", "next", main0);
    const base = commit(files, "main moves");
    git("checkout", "-q", "-B", "rebased", pr);
    const ok = spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "rebase", "-q", base], { encoding: "utf8" }).status === 0;
    if (!ok) git("rebase", "--abort");
    return { base, tree: ok ? treeOf("HEAD") : undefined };
  };

  test("the same tree on the same base: nothing it hasn't seen", () => {
    expect(since(repo, passed, passed.tree, main0)).toEqual([]);
    const p = plan(repo, passed.tree, main0, passes);
    expect(p.needed).toEqual(["fleetd", "site"]);
    expect(p.covered.fleetd).toEqual(passed);
    expect(p.run).toEqual({});
  });

  test("a clean merge of a newer main that touched none of the change's files still counts: nothing runs", () => {
    const { base, tree } = moved({ "fleetd/src/b.ts": lines(20, [9, "main's line"]), "README.md": "fleetd!\n" });
    expect(since(repo, passed, tree!, base)).toEqual([]);
    const p = plan(repo, tree!, base, passes);
    expect(p.covered.fleetd).toEqual(passed);
    expect(p.run.fleetd).toBeUndefined();
    expect(shell(p)).toContain("fleetd: passed on");
  });

  test("main's commits touched a file of the change: that file's tests run again, even though the merge is clean", () => {
    const { base, tree } = moved({ "fleetd/src/a.ts": lines(20, [15, "main's line"]) });
    expect(tree).toBeDefined();
    expect(since(repo, passed, tree!, base)).toEqual(["fleetd/src/a.ts"]);
    const p = plan(repo, tree!, base, passes);
    expect(p.covered.fleetd).toBeUndefined();
    expect(p.run.fleetd).toEqual(["test/a.test.ts"]);
  });

  test("the change's own edit since the pass: only what that edit reaches runs", () => {
    git("checkout", "-q", "-B", "more", pr);
    const head = commit({ "fleetd/src/b.ts": lines(20, [4, "the PR's second line"]) });
    expect(since(repo, passed, treeOf(head), main0)).toEqual(["fleetd/src/b.ts"]);
    const p = plan(repo, treeOf(head), main0, passes);
    expect(p.narrowed.fleetd?.files).toEqual(["fleetd/src/b.ts"]);
    expect(p.run.fleetd).toEqual(["test/b.test.ts"]);
  });

  test("an edit outside the check's paths leaves its pass whole: a desktop fix doesn't run fleetd again", () => {
    git("checkout", "-q", "-B", "desktop", pr);
    const head = commit({ "app/desktop/x.ts": lines(5, [1, "a fix"]) });
    const p = plan(repo, treeOf(head), main0, passes);
    expect(p.needed).toEqual(["fleetd", "site", "desktop"]);
    expect(p.covered.fleetd).toEqual(passed);
    expect(p.run).toEqual({ desktop: true });
  });

  test("a tree that isn't the pass's merged cleanly onto main: the pass doesn't count, and the whole change runs", () => {
    // Main rewrote the PR's own line: the rebase conflicts, and a resolution is a tree the pass never saw merged.
    const { base, tree } = moved({ "fleetd/src/a.ts": lines(20, [2, "main's own line"]) });
    expect(tree).toBeUndefined();
    git("checkout", "-q", "-B", "resolved", base);
    const resolved = commit({ "fleetd/src/a.ts": lines(20, [2, "the PR's line, on main's"]) });
    expect(since(repo, passed, treeOf(resolved), base)).toBeUndefined();
    const p = plan(repo, treeOf(resolved), base, passes);
    expect(p.covered.fleetd).toBeUndefined();
    expect(p.narrowed.fleetd).toBeUndefined();
    expect(p.run.fleetd).toEqual(["test/a.test.ts"]);
  });

  test("a pass on a base that isn't behind the current one doesn't count", () => {
    git("checkout", "-q", "-B", "elsewhere", main0);
    const other = commit({ "README.md": "another main\n" });
    expect(since(repo, { ...passed, base: other }, passed.tree, main0)).toBeUndefined();
  });

  test("the record: its pass lines, newest first, beside the pushable trees the pre-push hook reads", () => {
    const file = join(home.dir, "fleetd-checked");
    writeFileSync(file, `${"a".repeat(40)} fleetd\n${passed.tree}\n${passed.tree} ${main0} fleetd\n${passed.tree} ${main0} site\n`);
    expect(readPasses(file).map((p) => p.check)).toEqual(["site", "fleetd"]);
  });
});
