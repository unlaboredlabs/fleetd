// Edge builds only from green main commits: edge.yml starts on CI finishing with success on a push to main and builds
// that run's own commit, never main's newest; and every CI job runs in full on main, so no job passes there without
// running (a scoped job's "nothing changed" would read as green and let a merge another PR broke ship).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = join(import.meta.dir, "../../.github/workflows");
const text = (name: string) => readFileSync(join(WORKFLOWS, name), "utf8");
const yaml = (name: string) => Bun.YAML.parse(text(name)) as Record<string, any>;

/** Runs a job's scope script as GitHub would on `event` to `ref`, and returns what it wrote to GITHUB_OUTPUT. */
function scope(script: string, event: string, ref: string): string {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/fleetd-edge-green-${Math.random().toString(36).slice(2)}`;
  const run = (args: string[], cwd = dir) => Bun.spawnSync(args, { cwd, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.invalid", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.invalid" } });
  Bun.spawnSync(["mkdir", "-p", dir]);
  run(["git", "init", "-q", "-b", "main"]);
  run(["git", "commit", "-q", "--allow-empty", "-m", "one"]);
  // A second commit that changes nothing any scope reads.
  Bun.write(join(dir, "elsewhere.txt"), "x\n");
  run(["git", "add", "-A"]);
  run(["git", "commit", "-q", "-m", "two"]);
  const out = join(dir, "out.txt");
  Bun.spawnSync(["bash", "-c", script], { cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_OUTPUT: out } });
  const written = Bun.file(out).size > 0 ? readFileSync(out, "utf8") : "";
  Bun.spawnSync(["rm", "-rf", dir]);
  return written;
}

test("edge builds a main commit only once CI passed on it, and builds that commit", () => {
  const edge = yaml("edge.yml");
  expect(edge.on.push).toBeUndefined();
  expect(edge.on.workflow_run).toEqual({ workflows: [yaml("ci.yml").name], types: ["completed"], branches: ["main"] });
  const job = edge.jobs.edge;
  expect(job.if).toContain("github.event.workflow_run.conclusion == 'success'");
  expect(job.if).toContain("github.event.workflow_run.event == 'push'");
  expect(job.with.sha).toBe("${{ github.event.workflow_run.head_sha || '' }}");
  // Every job of the build checks out, and publishes, that commit.
  const build = text("build-release.yml");
  expect(yaml("build-release.yml").env.RELEASE_SHA).toBe("${{ inputs.sha || github.sha }}");
  const checkouts = build.split("\n").filter((l) => l.includes("uses: actions/checkout@")).length;
  expect(build.split("\n").filter((l) => l.includes("ref: ${{ env.RELEASE_SHA }}")).length).toBe(checkouts);
  expect(build).not.toContain("$GITHUB_SHA");
});

test("every scoped CI job runs in full on a push to main, and still skips an unchanged PR", () => {
  const ci = yaml("ci.yml");
  const scripts = Object.entries(ci.jobs as Record<string, { steps?: { id?: string; run?: string }[] }>)
    .map(([name, j]) => [name, j.steps?.find((s) => s.id === "scope")?.run] as const)
    .filter((x): x is readonly [string, string] => x[1] !== undefined && !x[1].includes("fleetd-scope.sh"));
  // desktop, desktop-packaged, desktop-budgets, desktop (mac layout) and the phone app's scope.
  expect(scripts.length).toBeGreaterThanOrEqual(5);
  for (const [name, script] of scripts) {
    const onMain = scope(script, "push", "refs/heads/main");
    const onPr = scope(script, "pull_request", "refs/pull/1/merge");
    expect([name, onMain.includes("=false")]).toEqual([name, false]);
    expect([name, onPr.includes("=false")]).toEqual([name, true]);
  }
  // fleetd's own scope script already runs in full on main.
  expect(readFileSync(join(import.meta.dir, "../../.github/fleetd-scope.sh"), "utf8")).toContain('"$GITHUB_EVENT_NAME" != push');
});

test("Desktop QA on main compares only with a run that passed: after a red one it runs in full", () => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/fleetd-main-base-${Math.random().toString(36).slice(2)}`;
  Bun.spawnSync(["mkdir", "-p", join(dir, "bin")]);
  // main's push runs of desktop-qa.yml, newest first: this run (3), B's red one (2), A's green one (1).
  const answers: Record<string, unknown> = {
    "repos/acme/storefront/actions/workflows/desktop-qa.yml/runs": {
      workflow_runs: [
        { id: 3, head_sha: "c".repeat(40) },
        { id: 2, head_sha: "b".repeat(40) },
        { id: 1, head_sha: "a".repeat(40) },
      ],
    },
    "repos/acme/storefront/actions/runs/2/jobs": { jobs: [{ name: "qa (ubuntu-latest, 1/4)", conclusion: "failure" }, { name: "qa (ubuntu-latest, 2/4)", conclusion: "success" }] },
    "repos/acme/storefront/actions/runs/1/jobs": { jobs: [{ name: "qa (ubuntu-latest, 1/4)", conclusion: "success" }, { name: "qa (ubuntu-latest, 2/4)", conclusion: "success" }] },
  };
  for (const [path, body] of Object.entries(answers)) Bun.write(join(dir, `${path.replaceAll("/", "_")}.json`), JSON.stringify(body));
  // A stand-in `gh api <path> -q <expr>`: the canned answer for the path, through jq.
  Bun.write(
    join(dir, "bin", "gh"),
    `#!/usr/bin/env bash\npath=""; expr="."\nwhile [ $# -gt 0 ]; do case "$1" in repos/*) path="\${1%%\\?*}";; -q) shift; expr="$1";; esac; shift; done\njq -r "$expr" "${dir}/\${path//\\//_}.json"\n`,
  );
  Bun.spawnSync(["chmod", "+x", join(dir, "bin", "gh")]);
  const out = Bun.spawnSync(["bash", join(import.meta.dir, "../../.github/main-base.sh"), "desktop-qa.yml", "qa ("], {
    env: { PATH: `${join(dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, GH_REPO: "acme/storefront", GITHUB_RUN_ID: "3", GH_TOKEN: "x" },
  });
  Bun.spawnSync(["rm", "-rf", dir]);
  // B's red run is no base: the run compares with A's, so B's change to app/desktop makes it run in full.
  expect(out.stdout.toString().trim()).toBe("a".repeat(40));
});
