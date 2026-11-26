// fleetd's own repo files the merge train reads: .fleetd/train.json names checks its workflows report, its
// .fleetd/regenerate.json is one the train can run, and no workflow gates on the label or leaves a check to a PR's head.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { batchSkipped, gatedName, jobChecks, labelGated } from "../src/hub/train/next.ts";
import { CONFIG_PATH, parseRegenerate } from "../src/hub/train/regen.ts";
import { parse, PATH } from "../src/hub/train/repo_checks.ts";

const ROOT = join(import.meta.dir, "../..");
const WORKFLOWS = join(ROOT, ".github/workflows");
type Job = { name?: string; if?: string; "runs-on"?: string; uses?: string; strategy?: { matrix?: { include?: string } } };
type Workflow = { name?: string; on?: Record<string, { paths?: unknown } | null>; jobs: Record<string, Job> };
const workflow = (name: string) => Bun.YAML.parse(readFileSync(join(WORKFLOWS, name), "utf8")) as Workflow;
const settings = parse(readFileSync(join(ROOT, PATH), "utf8"));

/** desktop-qa.yml's `qa` check names on `os`: its name with each matrix entry (a fromJSON of literal entries) put in. */
function qaShards(os: string): string[] {
  const qa = workflow("desktop-qa.yml").jobs.qa!;
  expect(qa["runs-on"]).toBe("${{ matrix.os }}");
  return [...(qa.strategy?.matrix?.include ?? "").matchAll(/\{[^{}]*\}/g)]
    .map((m) => JSON.parse(m[0]) as Record<string, unknown>)
    .filter((entry) => entry.os === os)
    .map((entry) => Object.entries(entry).reduce((name, [k, v]) => name.replaceAll(`\${{ matrix.${k} }}`, String(v)), qa.name!));
}

test("the train's fast checks are Linux jobs of ci.yml, the perf budgets among them, and every Linux QA shard", () => {
  // ci.yml runs on every PR's push: a scope step or job, never a paths filter, so each check always reports.
  expect(workflow("ci.yml").on?.pull_request?.paths).toBeUndefined();
  const jobs = Object.entries(workflow("ci.yml").jobs);
  const shards = qaShards("ubuntu-latest");
  expect(shards).toHaveLength(4);
  for (const shard of shards) expect(settings.fastChecks).toContain(shard);
  expect(settings.fastChecks).toContain("fleetd");
  expect(settings.fastChecks).toContain("mobile");
  // A PR that breaks the desktop's perf budgets never merges: they run on PRs, and the train waits for them.
  expect(settings.fastChecks).toContain("desktop-budgets");
  for (const check of settings.fastChecks) {
    if (shards.includes(check)) continue;
    const job = jobs.find(([id, j]) => (j.name ?? id) === check)?.[1];
    // desktop-budgets pins the Ubuntu image its baselines were measured on.
    expect(job ? String(job["runs-on"]) : `${PATH} names ${check}, which no job of ci.yml is`).toMatch(/^ubuntu-/);
    expect(job?.if ?? "").not.toContain("pull_request");
  }
});

test("ci.yml's one macOS job compiles the iOS app on main only, on the release's image", () => {
  const ci = workflow("ci.yml");
  const mac = Object.entries(ci.jobs).filter(([, j]) => !String(j["runs-on"]).startsWith("ubuntu-"));
  expect(mac.map(([id]) => id)).toEqual(["ios"]);
  const ios = ci.jobs.ios!;
  // The same image as TestFlight's archive: a build that passes on another Xcode can still break the release.
  expect(ios["runs-on"]).toBe(workflow("mobile-release.yml").jobs.ios?.["runs-on"]);
  // Never on a pull request (ci.no-macos-on-prs): on a push to main, or a manual run, that changed native inputs.
  expect(ios.if).toContain("needs.mobile-scope.outputs.ios != 'false'");
  expect(ios.if).toContain("(github.event_name == 'push' && github.ref == 'refs/heads/main')");
  expect(ios.if).not.toContain("pull_request");
  // On main's run, so the train's watch bisects and reverts a red one; no fast check, nor left to after the merge.
  expect(settings.fastChecks).not.toContain(ios.name);
  expect(settings.afterMerge).not.toContain(ios.name);
});

test("no workflow keys a cache by commit", () => {
  // One entry per commit (ccache's for Android was about 460 MB each) filled the repository's 10 GB of caches, and GitHub
  // then evicted every other cache: an entry is keyed by its inputs, so commits with the same ones share it.
  const keyed = readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml"))
    .flatMap((f) => readFileSync(join(WORKFLOWS, f), "utf8").split("\n").map((line) => [f, line.trim()] as const))
    .filter(([, line]) => /^(key|restore-keys):/.test(line) && /github\.sha|GITHUB_SHA|github\.run_id/.test(line));
  expect(keyed).toEqual([]);
});

test("the train's after-merge checks are what mac.yml reports", () => {
  // No PR runs a macOS job: each check mac.yml (Nightly) reports, the iOS build of a manual run among them, is after
  // merge only. mac.yml never starts on a push or a pull request by itself.
  const nightly = workflow("mac.yml");
  expect(Object.keys(nightly.on ?? {}).sort()).toEqual(["schedule", "workflow_call", "workflow_dispatch"]);
  const mac: string[] = [];
  for (const [id, job] of Object.entries(nightly.jobs)) {
    if (job.uses === "./.github/workflows/desktop-qa.yml") {
      const shards = qaShards("macos-latest");
      expect(shards).toHaveLength(4);
      mac.push(...shards.map((s) => `${id} / ${s}`));
    } else if (["macos-latest", "xcode-27"].includes(String(job["runs-on"])) && id !== "ios-screens") {
      mac.push(job.name ?? id);
    }
  }
  // The iOS builds take the image with Xcode 27 (an older SDK letterboxes the app on the iPhone Duo), a label that
  // exists: one no runner has leaves the job queued for good.
  expect(nightly.jobs.mobile?.["runs-on"]).toBe(workflow("mobile-release.yml").jobs.ios?.["runs-on"]);
  expect(nightly.jobs.mobile?.["runs-on"]).toBe(nightly.jobs["ios-screens"]?.["runs-on"]);
  expect(mac).toContain("mobile (ios)");
  // The link check, which the train doesn't leave for after the merge, runs only in the workflow's own nightly or a
  // manual run of it alone: never in an on-demand run of the Mac checks on a PR's head, nor in release.yml's call
  // (github.workflow is Release there), so it never holds a PR or gates a release.
  const links = nightly.jobs["site-external-links"]?.if;
  expect(links).toContain(`github.workflow == '${nightly.name}'`);
  expect(links).toContain("(github.event_name == 'schedule' || inputs.only == 'links')");
  expect([...settings.afterMerge].sort()).toEqual(mac.sort());
});

test("no workflow gates on the label or leaves a check to each PR's own head, and every fast check is a job's", () => {
  const files = readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith(".yml"))
    .sort()
    .map((f): [string, string] => [`.github/workflows/${f}`, readFileSync(join(WORKFLOWS, f), "utf8")]);
  expect(labelGated(files)).toEqual([]);
  expect(batchSkipped(files)).toEqual([]);
  const jobs = jobChecks(files);
  for (const name of settings.fastChecks) expect(jobs.some((j) => gatedName(j, name)) ? name : `${name}: ${jobs.join(", ")}`).toBe(name);
});

test("the repo's regenerate config is one the train can run", () => {
  const config = parseRegenerate(readFileSync(join(ROOT, CONFIG_PATH), "utf8"));
  expect(config.generated).toContain("fleetd/src/gen/");
  expect(config.migrations).toBe("fleetd/src/hub/store/migrations/");
  // fleetd.sh's bot is a bundle of the app's code: two PRs that both change it are rebuilt, not bounced.
  expect(config.generated).toContain("site/pebble.js");
  expect(config.run.some((c) => c.includes("pnpm site:pebble"))).toBe(true);
});
