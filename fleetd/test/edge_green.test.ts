// Edge builds only from green main commits: edge.yml starts on CI finishing with success on a push to main and builds
// that run's own commit, never main's newest; and every CI job runs in full on main, so no job passes there without
// running (a scoped job's "nothing changed" would read as green and let a merge another PR broke ship). All but the iOS
// build, main's only, scoped there to what the push changed: half an hour on a Mac each merge would hold every edge
// build, and it compiles nothing else.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = join(import.meta.dir, "../../.github/workflows");
const text = (name: string) => readFileSync(join(WORKFLOWS, name), "utf8");
const yaml = (name: string) => Bun.YAML.parse(text(name)) as Record<string, any>;

/** Runs a job's scope script as GitHub would on `event` to `ref`, and returns what it wrote to GITHUB_OUTPUT. */
function scope(script: string, event: string, ref: string, env: Record<string, string> = {}): string {
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
  Bun.spawnSync(["bash", "-c", script], { cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GITHUB_EVENT_NAME: event, GITHUB_REF: ref, GITHUB_OUTPUT: out, ...env } });
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
  // The iOS build alone keeps its scope on main, against the commit before the push (its `before`): skipped when the
  // push changed nothing it reads, in full when that commit is unknown (above, where it isn't given).
  const mobile = scripts.find(([name]) => name === "mobile-scope")![1];
  const pushed = scope(mobile, "push", "refs/heads/main", { BEFORE: "HEAD~1" });
  expect(pushed).toContain("ios=false");
  expect(pushed).toContain("app=true");
  expect(scope(mobile, "push", "refs/heads/main", { BEFORE: "0".repeat(40) })).toContain("ios=true");
  expect(scope(mobile, "workflow_dispatch", "refs/heads/main")).toContain("ios=true");
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

/** build-release.yml's plan step run on a repo of two commits, `one` then `two`, with edge's release.json holding
 * `held` (a stand-in curl answers it, `heldBuild` its build number) and origin holding the build tags `tags` (none
 * when origin can't be reached): its outputs, and the step's exit status and output as `status` and `log`. */
function plan(
  release: "one" | "two",
  held: "one" | "two" | undefined,
  event = "workflow_run",
  forceApp = "false",
  { tags = [], heldBuild = "2026.11.23.1" }: { tags?: string[] | null; heldBuild?: string } = {},
): Record<string, string> {
  const step = (yaml("build-release.yml").jobs.plan.steps as { id?: string; run: string }[]).find((s) => s.id === "plan")!;
  const dir = `${process.env.TMPDIR ?? "/tmp"}/fleetd-edge-plan-${Math.random().toString(36).slice(2)}`;
  const env = { PATH: `${dir}/bin:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.invalid", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.invalid" };
  const run = (args: string[]) => Bun.spawnSync(args, { cwd: dir, env }).stdout.toString().trim();
  Bun.spawnSync(["mkdir", "-p", `${dir}/bin`, `${dir}/fleetd`]);
  run(["git", "init", "-q", "-b", "main"]);
  Bun.write(join(dir, "fleetd/package.json"), "{}\n");
  Bun.spawnSync(["mkdir", "-p", `${dir}/.github/release`]);
  Bun.write(join(dir, ".github/release/minor"), readFileSync(join(import.meta.dir, "../../.github/release/minor")));
  run(["git", "add", "-A"]);
  run(["git", "commit", "-q", "-m", "one"]);
  const one = run(["git", "rev-parse", "HEAD"]);
  run(["git", "commit", "-q", "--allow-empty", "-m", "two"]);
  const two = run(["git", "rev-parse", "HEAD"]);
  const sha = { one, two };
  // origin: a bare repo with the build tags, each at `one`.
  if (tags !== null) {
    run(["git", "init", "-q", "--bare", `${dir}/origin.git`]);
    run(["git", "remote", "add", "origin", `${dir}/origin.git`]);
    for (const t of tags) run(["git", "push", "-q", "origin", `${one}:refs/tags/${t}`]);
  } else run(["git", "remote", "add", "origin", `${dir}/gone.git`]);
  const json = held === undefined ? "" : JSON.stringify({ commit: sha[held], appCommit: sha[held], build: heldBuild });
  Bun.write(join(dir, "bin/curl"), `#!/bin/sh\nprintf '%s' '${json}'\n`);
  Bun.spawnSync(["chmod", "+x", join(dir, "bin/curl")]);
  const out = join(dir, "out.txt");
  // As GitHub runs a step: bash -eo pipefail.
  const ran = Bun.spawnSync(["bash", "-eo", "pipefail", "-c", step.run], {
    cwd: dir,
    env: { ...env, CHANNEL: "edge", PUBLISH: "true", FORCE_APP: forceApp, GITHUB_EVENT_NAME: event, RELEASE_SHA: sha[release], GITHUB_REPOSITORY: "unlaboredlabs/fleetd", GITHUB_OUTPUT: out },
  });
  const written = Bun.file(out).size > 0 ? readFileSync(out, "utf8") : "";
  Bun.spawnSync(["rm", "-rf", dir]);
  return {
    ...Object.fromEntries(written.split("\n").filter(Boolean).map((l) => l.split("=", 2) as [string, string])),
    status: String(ran.exitCode),
    log: `${ran.stdout.toString()}${ran.stderr.toString()}`,
  };
}

test("a run for a commit edge already holds, or an older one, builds and publishes nothing: the newest commit builds next", () => {
  expect(plan("one", "two")).toMatchObject({ skip: "true", "has-cli": "false", "build-app": "false" });
  expect(plan("two", "two")).toMatchObject({ skip: "true", "has-cli": "false" });
  // A newer commit than edge's builds, as does the first build of all.
  expect(plan("two", "one")).toMatchObject({ skip: "false", "has-cli": "true" });
  expect(plan("two", undefined)).toMatchObject({ skip: "false", "has-cli": "true", "build-app": "true" });
  // A run by hand always builds: Rebuild the app on the commit edge holds, or a dispatch from main.
  expect(plan("two", "two", "workflow_dispatch", "true")).toMatchObject({ skip: "false", "has-cli": "true", "build-app": "true" });
  expect(plan("two", "two", "workflow_dispatch")).toMatchObject({ skip: "false", "has-cli": "true" });
  expect(plan("two", "two", "workflow_run", "true")).toMatchObject({ skip: "false", "build-app": "true" });
  // The build number counts on from the one edge holds, read in the same look.
  expect(plan("two", "one").build).toMatch(/\.\d+$/);
  // And a skipped plan skips the publish.
  expect(yaml("build-release.yml").jobs.publish.if).toContain("needs.plan.outputs.skip != 'true'");
});

test("a build's number is one past the highest build tag of its MINOR, and a plan that can't list the tags fails", () => {
  const minor = readFileSync(join(import.meta.dir, "../../.github/release/minor"), "utf8").trim();
  const tags = [5, 9, 10, 49, 3].map((n) => `build-${minor}.${n}`).concat(["build-2026.11.23.4", `build-${minor}9.70`, `build-${minor}.12-x`]);
  // As on Nov 26 at 20:03: edge's release.json was being replaced and read as nothing, yet the number goes on from 49.
  expect(plan("two", undefined, "workflow_run", "false", { tags })).toMatchObject({ status: "0", build: `${minor}.50` });
  expect(plan("two", undefined, "workflow_run", "false", { tags }).version).toStartWith(`${minor}.50+`);
  // Edge's release.json, read, never pulls it back either, and its own build counts should its tag be missing.
  expect(plan("two", "one", "workflow_run", "false", { tags, heldBuild: `${minor}.7` }).build).toBe(`${minor}.50`);
  expect(plan("two", "one", "workflow_run", "false", { tags, heldBuild: `${minor}.60` }).build).toBe(`${minor}.61`);
  // The first build of a new MINOR, with no tag of it yet, is 0.
  expect(plan("two", undefined, "workflow_run", "false", { tags: ["build-2026.11.23.4"] }).build).toBe(`${minor}.0`);
  // origin unreachable: the plan fails loudly and plans no build, rather than start again at 0.
  const failed = plan("two", undefined, "workflow_run", "false", { tags: null });
  expect(failed.status).not.toBe("0");
  expect(failed.build).toBeUndefined();
  expect(failed.log).toContain(`couldn't list the build-${minor}.* tags`);
});

/** publish.sh run for build 0.9.12 of `two` (a CLI build in dist/), on a repo whose origin has build-0.9.12 at `tagged`
 * (none when undefined), against a stand-in gh that logs each call and holds no release: its status, output and gh's
 * calls. */
function publishAs(tagged: "one" | "two" | undefined): { status: number; log: string; calls: string[] } {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/fleetd-edge-publish-${Math.random().toString(36).slice(2)}`;
  const env = { PATH: `${dir}/bin:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.invalid", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.invalid" };
  const run = (args: string[]) => Bun.spawnSync(args, { cwd: dir, env }).stdout.toString().trim();
  Bun.spawnSync(["mkdir", "-p", `${dir}/bin`, `${dir}/dist`]);
  run(["git", "init", "-q", "-b", "main"]);
  run(["git", "commit", "-q", "--allow-empty", "-m", "one"]);
  const one = run(["git", "rev-parse", "HEAD"]);
  run(["git", "commit", "-q", "--allow-empty", "-m", "two"]);
  const two = run(["git", "rev-parse", "HEAD"]);
  run(["git", "init", "-q", "--bare", `${dir}/origin.git`]);
  run(["git", "remote", "add", "origin", `${dir}/origin.git`]);
  if (tagged !== undefined) run(["git", "push", "-q", "origin", `${{ one, two }[tagged]}:refs/tags/build-0.9.12`]);
  Bun.write(join(dir, "dist/fleetd-bun-linux-x64"), "cli\n");
  // gh: every call logged; no release exists, so each read fails as GitHub's does.
  Bun.write(join(dir, "bin/gh"), `#!/bin/sh\necho "$*" >> "${dir}/gh.log"\ncase "$2" in download|view) exit 1;; esac\n`);
  Bun.spawnSync(["chmod", "+x", join(dir, "bin/gh")]);
  const ran = Bun.spawnSync(["bash", join(import.meta.dir, "../../.github/release/publish.sh")], {
    cwd: dir,
    env: { ...env, CHANNEL: "edge", VERSION: "0.9.12+20261127.6c77787", BUILD: "0.9.12", APP_BUILT: "false", CLI_PUBLISH: "true", RELEASE_SHA: two, GH_TOKEN: "x" },
  });
  const calls = Bun.file(join(dir, "gh.log")).size > 0 ? readFileSync(join(dir, "gh.log"), "utf8").trim().split("\n") : [];
  Bun.spawnSync(["rm", "-rf", dir]);
  return { status: ran.exitCode, log: `${ran.stdout.toString()}${ran.stderr.toString()}`, calls };
}

test("a publish never puts a build into another commit's build-<number> release", () => {
  // As on Nov 27: build-0.9.12 is Nov 25's build, and a build that got its number again stops before any upload.
  const reused = publishAs("one");
  expect(reused.status).not.toBe(0);
  expect(reused.log).toContain("build-0.9.12 is already");
  expect(reused.calls.filter((c) => /^release (create|upload|edit)/.test(c))).toEqual([]);
  // Its own number, new or (a re-run of the publish) already its own, goes up as before.
  for (const tagged of [undefined, "two"] as const) {
    const own = publishAs(tagged);
    expect(own.log).not.toContain("is already");
    expect(own.calls).toContainEqual(expect.stringMatching(/^release upload build-0\.9\.12 /));
  }
});
