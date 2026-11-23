// The cloud's pin bump after a merge (cloud-pin.yml): a push to main whose CI passed starts fleetd-cloud's
// fleet-pin-bump for that very commit, and the job never fails (the train reads a workflow_run's result on main as
// main's CI): a missing token or a refused dispatch leaves a warning, and the cloud's schedule moves the pin.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const TEXT = readFileSync(join(ROOT, ".github/workflows/cloud-pin.yml"), "utf8");
type Step = { env?: Record<string, string>; run?: string };
const WORKFLOW = Bun.YAML.parse(TEXT) as { on: Record<string, { workflows?: string[]; branches?: string[]; types?: string[] }>; permissions: unknown; jobs: Record<string, { if: string; steps: Step[] }> };
const STEP = WORKFLOW.jobs.dispatch!.steps[0]!;
const SHA = "5".repeat(40);

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

test("only a push to main whose CI passed, in this repository, starts it, and it names that very commit", () => {
  expect(Object.keys(WORKFLOW.on)).toEqual(["workflow_run"]);
  expect(WORKFLOW.on.workflow_run).toEqual({ workflows: ["CI"], types: ["completed"], branches: ["main"] });
  const when = WORKFLOW.jobs.dispatch!.if;
  expect(when).toContain("github.event.workflow_run.conclusion == 'success'");
  expect(when).toContain("github.event.workflow_run.event == 'push'");
  // A fork's pull request runs CI too, and a workflow_run has this repository's secrets.
  expect(when).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
  expect(WORKFLOW.permissions).toEqual({});
  expect(STEP.env).toEqual({ GH_TOKEN: "${{ secrets.CLOUD_PIN_TOKEN }}", SHA: "${{ github.event.workflow_run.head_sha }}" });
});

/** The step's script with `token` as its GH_TOKEN, against a stand-in `gh` that records its arguments and exits `exit`. */
function dispatch(token: string, exit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "cloud-pin-"));
  dirs.push(dir);
  writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/calls"\nexit ${exit}\n`);
  chmodSync(join(dir, "gh"), 0o755);
  writeFileSync(join(dir, "calls"), "");
  writeFileSync(join(dir, "summary"), "");
  const r = spawnSync("bash", ["-e", "-c", STEP.run!], {
    env: { PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: token, SHA, GITHUB_STEP_SUMMARY: join(dir, "summary") },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, calls: readFileSync(join(dir, "calls"), "utf8"), summary: readFileSync(join(dir, "summary"), "utf8") };
}

test("it dispatches the cloud's pin bump on its main for the commit CI passed on", () => {
  const r = dispatch("t");
  expect(r.code).toBe(0);
  expect(r.calls).toBe(`workflow run fleet-pin-bump.yml -R unlaboredlabs/fleetd-cloud --ref main -f sha=${SHA}\n`);
  expect(r.summary).toBe("The cloud's pin bump started for fleetd 5555555\n");
});

test("with no token, or a dispatch GitHub refuses, it warns and passes: main's CI stays green", () => {
  const missing = dispatch("");
  expect(missing.code).toBe(0);
  expect(missing.calls).toBe("");
  expect(missing.out).toStartWith("::warning::The cloud's pin bump wasn't started: this repository has no CLOUD_PIN_TOKEN secret");

  const refused = dispatch("t", 1);
  expect(refused.code).toBe(0);
  expect(refused.out).toStartWith("::warning::The cloud's pin bump wasn't started for fleetd 5555555: GitHub refused the dispatch");
  expect(refused.summary).toBe("");
});
