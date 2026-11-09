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
type Job = { name?: string; "runs-on"?: string; uses?: string; strategy?: { matrix?: { include?: string } } };
type Workflow = { on?: Record<string, { paths?: unknown } | null>; jobs: Record<string, Job> };
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

test("the train's fast checks are Linux jobs of ci.yml, fleetd.yml and mobile.yml, and every Linux QA shard", () => {
  // fleetd.yml and mobile.yml run on every PR's push as ci.yml does: a scope step or job, never a paths filter, so each
  // check always reports.
  for (const name of ["fleetd.yml", "mobile.yml"]) expect(workflow(name).on?.pull_request?.paths).toBeUndefined();
  const jobs = ["ci.yml", "fleetd.yml", "mobile.yml"].flatMap((name) => Object.entries(workflow(name).jobs));
  const shards = qaShards("ubuntu-latest");
  expect(shards).toHaveLength(4);
  for (const shard of shards) expect(settings.fastChecks).toContain(shard);
  expect(settings.fastChecks).toContain("fleetd");
  expect(settings.fastChecks).toContain("mobile");
  for (const check of settings.fastChecks) {
    if (shards.includes(check)) continue;
    const job = jobs.find(([id, j]) => (j.name ?? id) === check)?.[1];
    expect(job ? job["runs-on"] : `${PATH} names ${check}, which no job of ci.yml, fleetd.yml or mobile.yml is`).toBe("ubuntu-latest");
  }
});

test("the train's after-merge checks are what mac.yml reports, and besides those only Linux jobs of ci.yml", () => {
  // No PR runs a macOS job: each check mac.yml reports, and the iOS build of a manual Mobile run, is after merge only.
  const mac = ["mobile (ios)"];
  for (const [id, job] of Object.entries(workflow("mac.yml").jobs)) {
    if (job.uses === "./.github/workflows/desktop-qa.yml") {
      const shards = qaShards("macos-latest");
      expect(shards).toHaveLength(3);
      mac.push(...shards.map((s) => `${id} / ${s}`));
    } else if (job.uses) {
      for (const [cid, cjob] of Object.entries(workflow(job.uses.replace("./.github/workflows/", "")).jobs)) {
        if (cjob["runs-on"] === "macos-latest") mac.push(`${id} / ${cjob.name ?? cid}`);
      }
    } else if (job["runs-on"] === "macos-latest") mac.push(job.name ?? id);
  }
  const ci = Object.entries(workflow("ci.yml").jobs);
  const linux = (check: string) => ci.some(([id, j]) => (j.name ?? id) === check && j["runs-on"] === "ubuntu-latest");
  expect(settings.afterMerge.filter((c) => !linux(c)).sort()).toEqual(mac.sort());
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
});
