// The regeneration script itself, run as the hub has a node run it: the argv `scriptArgv` builds, through the node's
// `cmd_check` runner, under plain `sh` (dash on the devbox and on CI's Ubuntu), in a throwaway git repo with an
// `origin/main` and no network. The train tests fake the node, so nothing else puts the script through a shell.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRegenerate, scriptArgv } from "../src/hub/train/regen.ts";
import { runCmdCheck } from "../src/node/cmd/index.ts";
import { tempHome } from "./helpers.ts";

// Each git step is a process of its own: a loaded machine (CI, or a busy devbox) takes longer than bun's 5 s default.
setDefaultTimeout(30_000);

let homes: { done: () => void }[] = [];
afterEach(() => {
  for (const h of homes) h.done();
  homes = [];
});

// The repo's generator: `list.txt` (a generated file) and `gen/all.txt` (in a generated directory) from `src/`.
const GENERATE = "ls src > list.txt && mkdir -p gen && cat src/* > gen/all.txt";
const CONFIG = parseRegenerate(JSON.stringify({ generated: ["gen/", "list.txt"], run: [GENERATE] }));

/** A repo whose `main` (also `origin/main`) and branch `pr` each add a source file and regenerate. */
function repo() {
  const home = tempHome();
  homes.push(home);
  const dir = join(home.dir, "repo");
  mkdirSync(join(dir, "src"), { recursive: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const sh = (cmd: string) => {
    const r = Bun.spawnSync(["sh", "-c", cmd], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`${cmd}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    sh(`${GENERATE} && git add -A && git commit -q -m '${message}'`);
  };
  sh("git init -q -b main");
  commit({ "src/a.txt": "a\n" }, "base");
  sh("git checkout -q -b pr");
  return { home, dir, sh, commit };
}

/** The script on the PR's head, as `regenerate` sends it: its exit code and what the hub reads from its output. */
async function run(r: ReturnType<typeof repo>) {
  r.sh("git update-ref refs/remotes/origin/main main");
  const head = r.sh("git rev-parse pr");
  const argv = scriptArgv("acme/widgets", "main", head, "Add c", CONFIG);
  const ran = await runCmdCheck({ id: "regen", cwd: r.dir, argv, timeoutSec: 60 }, [r.home.dir], join(r.home.dir, "node"));
  const said = ran.outputTail.split("\n").filter((l) => l.startsWith("fleetd-regenerate: ")).at(-1)?.slice("fleetd-regenerate: ".length);
  return { exitCode: ran.exitCode, said, output: ran.outputTail };
}

test("the script the hub sends parses under sh", () => {
  const [, , script] = scriptArgv("acme/widgets", "main", "0".repeat(40), "title", CONFIG);
  const r = Bun.spawnSync(["sh", "-n", "-c", script!], { stdout: "pipe", stderr: "pipe" });
  expect(r.stderr.toString()).toBe("");
  expect(r.exitCode).toBe(0);
});

test("a PR that conflicts with its base only in generated files is rebased and regenerated", async () => {
  const r = repo();
  r.commit({ "src/c.txt": "c\n" }, "Add c");
  r.sh("git checkout -q main");
  r.commit({ "src/b.txt": "b\n" }, "Add b");
  const base = r.sh("git rev-parse main");
  const out = await run(r);
  expect(out.output).toContain("fleetd-regenerate: done ");
  expect(out.exitCode).toBe(0);
  const sha = out.said!.slice("done ".length);
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  expect(r.sh(`git merge-base --is-ancestor ${base} ${sha} && echo on-base`)).toBe("on-base");
  expect(r.sh(`git show ${sha}:list.txt`)).toBe("a.txt\nb.txt\nc.txt");
  expect(r.sh(`git show ${sha}:gen/all.txt`)).toBe("a\nb\nc");
  expect(r.sh(`git log --format=%s ${base}..${sha}`)).toBe("Regenerate the generated files on main (fleetd merge train)\nAdd c");
  // The scratch worktree is gone and the checkout is as it was.
  expect(r.sh("git worktree list --porcelain | grep -c '^worktree '")).toBe("1");
  expect(r.sh("git status --porcelain")).toBe("");
});

test("a PR that conflicts with its base in a source file is refused", async () => {
  const r = repo();
  r.commit({ "src/a.txt": "a from the PR\n" }, "Change a");
  r.sh("git checkout -q main");
  r.commit({ "src/a.txt": "a from main\n" }, "Change a on main");
  const out = await run(r);
  expect(out.exitCode).toBe(3);
  expect(out.said).toBe("it conflicts with main in src/a.txt, which is not a generated file");
  expect(r.sh("git worktree list --porcelain | grep -c '^worktree '")).toBe("1");
});
