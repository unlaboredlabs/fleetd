// Mobile release after a merge (mobile-merged.yml, mobile-release.yml, .github/release/mobile-due.sh): it builds the very
// commit CI passed on, and sends it to TestFlight only when the files the phone app's binary is built from changed
// since the commit the last build sent there was of; runs by hand still build whatever they're asked. That it watches every file the app imports: app/mobile/scripts/release.test.ts.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const SCRIPT = join(ROOT, ".github/release/mobile-due.sh");
const WORKFLOW = readFileSync(join(ROOT, ".github/workflows/mobile-release.yml"), "utf8");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const MERGED = readFileSync(join(ROOT, ".github/workflows/mobile-merged.yml"), "utf8");

test("a merge starts it by a dispatch, by hand still works, on the xcode-27 runner, and the gate starts no build", () => {
  expect(WORKFLOW).toMatch(/^ {2}workflow_dispatch:$/m);
  // No schedule (it would build main's head whatever its CI says) and no trigger of its own the train would count as
  // main's CI: a merge dispatches it (NOT_THE_MERGES).
  expect(WORKFLOW).not.toMatch(/^ {2}(schedule|push|workflow_run):/m);
  expect(WORKFLOW).toContain("runs-on: xcode-27");
  expect(WORKFLOW).toContain(".github/release/mobile-due.sh due");
  expect(WORKFLOW).toContain("if: inputs.only_if_changed");
  expect(WORKFLOW).toMatch(/^ {6}only_if_changed:$/m);
  expect(MERGED).toContain("if: github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push'");
  // The step whose name the script reads off a run.
  expect(WORKFLOW).toContain("'Upload to TestFlight'");
  expect(readFileSync(SCRIPT, "utf8")).toContain('select(.name == "Upload to TestFlight" and .conclusion == "success")');
});

test("TestFlight gets only the commit CI passed on: the dispatch names it and every job checks it out", () => {
  // The dispatch passes the commit CI passed on, never main's newest.
  expect(MERGED).toContain("SHA: ${{ github.event.workflow_run.head_sha }}");
  expect(MERGED).toContain('gh workflow run mobile-release.yml --ref main -f sha="$SHA" -f testflight=true -f only_if_changed=true');
  expect(WORKFLOW).toMatch(/^ {6}sha:$/m);
  // Every job builds from that commit, and the gate compares it.
  const checkouts = [...WORKFLOW.matchAll(/- uses: actions\/checkout@[^\n]+\n((?: {8}.*\n)*)/g)].map(([, w]) => w!);
  expect(checkouts.length).toBe(4);
  // `signing` runs the gate from the workflow's own commit, whose scripts this workflow calls (build 36 failed running
  // fb11f5e's older mobile-due.sh); `runtime`, `android` and `ios` build `sha`.
  const [gate, ...builds] = checkouts;
  expect(gate).not.toContain("ref:");
  for (const w of builds) expect(w).toContain("ref: ${{ inputs.sha || github.sha }}");
  expect(WORKFLOW).toContain("BUILD_SHA: ${{ inputs.sha || github.sha }}");
  // A commit not on the branch fails the run before anything is built; the run's name says which commit it built.
  expect(WORKFLOW).toContain("run: .github/release/mobile-due.sh commit");
  expect(WORKFLOW).toContain("run-name: ${{ inputs.sha && format('Mobile release of {0}', inputs.sha) || 'Mobile release' }}");
});

/** A run of the workflow as GitHub lists it, newest first: its head, the commit its name says it built, the steps its `ios` job ran. */
type Run = { id: number; sha: string; built?: string; steps?: string[] };

/** A repo with main's commits (each its files). Returns its dir and main's commits. */
function repo(commits: Record<string, string>[]): [string, string[]] {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mobile-due-"));
  dirs.push(dir);
  const work = join(dir, "repo");
  mkdirSync(work);
  const git = (...args: string[]) => spawnSync("git", ["-C", work, ...args], { encoding: "utf8" }).stdout.trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("remote", "add", "origin", work);
  const shas: string[] = [];
  for (const files of commits) {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      writeFileSync(join(work, file), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "c");
    shas.push(git("rev-parse", "HEAD"));
  }
  return [dir, shas];
}

/**
 * mobile-due.sh `command` in `dir`'s repo, building `build` with main at `head`, with a fake `gh` that lists `runs` and
 * compares commits as git does: its exit code, output and summary line.
 */
function script(command: string, dir: string, build: string, runs: Run[], upload = "true", head = build): [number | null, string, string] {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const title = (r: Run) => (r.built ? `Mobile release of ${r.built}` : "Mobile release");
  writeFileSync(join(dir, "runs.json"), JSON.stringify({ workflow_runs: runs.map((r) => ({ id: r.id, head_sha: r.sha, display_title: title(r) })) }));
  for (const r of runs) {
    const steps = (r.steps ?? []).map((name) => ({ name, conclusion: "success" }));
    writeFileSync(join(dir, `jobs-${r.id}.json`), JSON.stringify({ jobs: [{ name: "ios", steps }] }));
  }
  // gh api <path> --jq <expression>; a compare's status from git, as GitHub gives it.
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env bash",
      "set -e",
      'if [[ "$2" =~ compare/([^.]+)\.\.\.(.+)$ ]]; then',
      '  a="${BASH_REMATCH[1]}"; b="${BASH_REMATCH[2]}"',
      '  if [ "$a" = "$b" ]; then echo identical; elif git merge-base --is-ancestor "$a" "$b" 2>/dev/null; then echo ahead; else echo behind; fi',
      "  exit 0",
      "fi",
      'if [[ "$2" =~ runs/([0-9]+)/jobs ]]; then f="$FAKE/jobs-${BASH_REMATCH[1]}.json"; else f="$FAKE/runs.json"; fi',
      'jq -r "$4" "$f"',
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "gh"), 0o755);
  const summary = join(dir, "summary");
  writeFileSync(summary, "");
  const out = spawnSync("bash", [SCRIPT, command], {
    cwd: join(dir, "repo"),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE: dir,
      UPLOAD: upload,
      BUILD_SHA: build,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_REF_NAME: "main",
      GITHUB_SHA: head,
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  return [out.status, out.stdout.trim(), readFileSync(summary, "utf8").trim()];
}

/** mobile-due.sh due: its output and summary line. */
function due(dir: string, build: string, runs: Run[], upload = "true"): [string, string] {
  const [status, out, summary] = script("due", dir, build, runs, upload);
  expect(status).toBe(0);
  return [out, summary];
}

const UPLOADED = ["Archive", "Upload to TestFlight"];

test("it builds only when the phone app changed since the commit the last TestFlight build was of", () => {
  const [dir, [first, docs, test, app]] = repo([
    { "app/mobile/App.tsx": "1", "docs/a.md": "1" },
    { "docs/a.md": "2", "fleetd/src/x.ts": "2" },
    { "app/mobile/src/chat.test.ts": "3", "app/mobile/README.md": "3" },
    { "app/desktop/src/shared/contracts.ts": "4" },
  ]);
  const sent = { id: 9, sha: first!, built: first!, steps: UPLOADED };
  // Nothing the app is built from changed by `docs`, nor by a test or a note.
  for (const build of [docs!, test!]) {
    const [out, summary] = due(dir, build, [sent]);
    expect(out).toBe("build=false");
    expect(summary).toBe(`Nothing new for TestFlight: the phone app hasn't changed on main since ${first!.slice(0, 9)}.`);
  }
  // A desktop module the app imports did.
  const [out, summary] = due(dir, app!, [sent]);
  expect(out).toBe("build=true");
  expect(summary).toBe(`Building ${app!.slice(0, 9)} for TestFlight: 1 of the phone app's files changed on main since ${first!.slice(0, 9)}.`);
  // Sent from `app` since: the same commit is never built twice.
  expect(due(dir, app!, [{ id: 10, sha: app!, built: app!, steps: UPLOADED }, sent])[0]).toBe("build=false");
});

test("a build covers the commit its run's name says it built, not main's head when it started", () => {
  const [dir, [first, app, later]] = repo([{ "app/mobile/App.tsx": "1" }, { "app/mobile/App.tsx": "2" }, { "app/mobile/App.tsx": "3" }]);
  // Dispatched with main already at `later`, it built `first`: `app` and `later` still go out.
  const run = { id: 9, sha: later!, built: first!, steps: UPLOADED };
  expect(due(dir, app!, [run])).toEqual(["build=true", `Building ${app!.slice(0, 9)} for TestFlight: 1 of the phone app's files changed on main since ${first!.slice(0, 9)}.`]);
  expect(due(dir, later!, [run])[0]).toBe("build=true");
});

test("a commit older than one already sent builds nothing, as when two merges' CI finish out of order", () => {
  const [dir, [first, app, later]] = repo([{ "app/mobile/App.tsx": "1" }, { "app/mobile/App.tsx": "2" }, { "app/mobile/App.tsx": "3" }]);
  const sent = [{ id: 10, sha: later!, built: later!, steps: UPLOADED }, { id: 9, sha: first!, built: first!, steps: UPLOADED }];
  expect(due(dir, app!, sent)).toEqual(["build=false", `Nothing new for TestFlight: ${app!.slice(0, 9)} is in the build of ${later!.slice(0, 9)}, which went there already.`]);
});

test("a run covers its commit only when its build went to TestFlight", () => {
  const [dir, [first, app]] = repo([{ "app/mobile/App.tsx": "1" }, { "app/mobile/App.tsx": "2" }]);
  const older = { id: 1, sha: first!, built: first!, steps: UPLOADED };
  // An export, or a run that skipped (no steps), covers nothing.
  expect(due(dir, app!, [{ id: 3, sha: app!, built: app! }, { id: 2, sha: app!, steps: ["Archive", "Export"] }, older])[0]).toBe("build=true");
  expect(due(dir, app!, [{ id: 2, sha: app!, steps: UPLOADED }, older])[0]).toBe("build=false");
});

test("with no build sent yet it builds, and without TestFlight set up it never does", () => {
  const [dir, [head]] = repo([{ "app/mobile/App.tsx": "1" }]);
  const [out, summary] = due(dir, head!, []);
  expect(out).toBe("build=true");
  expect(summary).toBe(`Building ${head!.slice(0, 9)} for TestFlight: no earlier build from main went there.`);
  const [off, why] = due(dir, head!, [], "false");
  expect(off).toBe("build=false");
  expect(why).toStartWith("Nothing sent: TestFlight isn't set up here");
});

test("the commit to build must be a full id on the branch, at or before its head", () => {
  const [dir, [first, head]] = repo([{ "app/mobile/App.tsx": "1" }, { "app/mobile/App.tsx": "2" }]);
  expect(script("commit", dir, first!, [], "true", head!)[0]).toBe(0);
  expect(script("commit", dir, head!, [], "true", head!)[0]).toBe(0);
  // Newer than the branch's head when the run started, short, or not a commit id.
  expect(script("commit", dir, head!, [], "true", first!)[0]).toBe(1);
  expect(script("commit", dir, first!.slice(0, 9), [], "true", head!)[0]).toBe(1);
  expect(script("commit", dir, "main", [], "true", head!)[0]).toBe(1);
});
