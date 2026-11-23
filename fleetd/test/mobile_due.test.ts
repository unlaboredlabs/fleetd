// mobile-release.yml's schedule (.github/release/mobile-due.sh): a scheduled run builds and sends to TestFlight only
// when the files the phone app's binary is built from changed on main since the last commit a run covered, and runs
// by hand still build whatever they're asked. That it watches every file the app imports: app/mobile/scripts/release.test.ts.
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

test("the workflow runs on a schedule and by hand, on the xcode-27 runner, and the gate starts no build", () => {
  expect(WORKFLOW).toMatch(/^ {2}schedule:\n {4}- cron: "[^"]+"$/m);
  expect(WORKFLOW).toMatch(/^ {2}workflow_dispatch:$/m);
  expect(WORKFLOW).toContain("runs-on: xcode-27");
  expect(WORKFLOW).toContain(".github/release/mobile-due.sh due");
  // The step whose name the script reads off a run by hand.
  expect(WORKFLOW).toContain("'Upload to TestFlight'");
  expect(readFileSync(SCRIPT, "utf8")).toContain('select(.name == "Upload to TestFlight" and .conclusion == "success")');
});

/** A run of the workflow as GitHub lists it, newest first, and the steps its `ios` job ran. */
type Run = { id: number; event: string; sha: string; steps?: string[] };

/** A repo with main's commits (each its files), and a fake `gh` that lists `runs`. Returns its dir and main's commits. */
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

/** mobile-due.sh due in `dir`'s repo at main's head, with `runs` listed; its output and summary line. */
function due(dir: string, head: string, runs: Run[], upload = "true"): [string, string] {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(dir, "runs.json"), JSON.stringify({ workflow_runs: runs.map((r) => ({ id: r.id, event: r.event, head_sha: r.sha })) }));
  for (const r of runs) {
    const steps = (r.steps ?? []).map((name) => ({ name, conclusion: "success" }));
    writeFileSync(join(dir, `jobs-${r.id}.json`), JSON.stringify({ jobs: [{ name: "ios", steps }] }));
  }
  // gh api <path> --jq <expression>
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash\nset -e\nif [[ "$2" =~ runs/([0-9]+)/jobs ]]; then f="$FAKE/jobs-\${BASH_REMATCH[1]}.json"; else f="$FAKE/runs.json"; fi\njq -r "$4" "$f"\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const summary = join(dir, "summary");
  writeFileSync(summary, "");
  const out = spawnSync("bash", [SCRIPT, "due"], {
    cwd: join(dir, "repo"),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE: dir,
      UPLOAD: upload,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_REF_NAME: "main",
      GITHUB_SHA: head,
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  expect(out.status).toBe(0);
  return [out.stdout.trim(), readFileSync(summary, "utf8").trim()];
}

test("a scheduled run builds only when the phone app changed since the last covered commit", () => {
  const [dir, [first, docs, test, app]] = repo([
    { "app/mobile/App.tsx": "1", "docs/a.md": "1" },
    { "docs/a.md": "2", "fleetd/src/x.ts": "2" },
    { "app/mobile/src/chat.test.ts": "3", "app/mobile/README.md": "3" },
    { "app/desktop/src/shared/contracts.ts": "4" },
  ]);
  // The last scheduled run covered `first`: nothing the app is built from changed by `docs`, nor by a test or a note.
  for (const head of [docs!, test!]) {
    const [out, summary] = due(dir, head, [{ id: 9, event: "schedule", sha: first! }]);
    expect(out).toBe("build=false");
    expect(summary).toBe(`Nothing new for TestFlight: the phone app hasn't changed on main since ${first!.slice(0, 9)}.`);
  }
  // A desktop module the app imports did.
  const [out, summary] = due(dir, app!, [{ id: 9, event: "schedule", sha: first! }]);
  expect(out).toBe("build=true");
  expect(summary).toBe(`Building ${app!.slice(0, 9)} for TestFlight: 1 of the phone app's files changed on main since ${first!.slice(0, 9)}.`);
  // Covered by a newer scheduled run at `app`: the same commit is never built twice.
  expect(due(dir, app!, [{ id: 10, event: "schedule", sha: app! }, { id: 9, event: "schedule", sha: first! }])[0]).toBe("build=false");
});

test("a run by hand covers its commit only when its build went to TestFlight", () => {
  const [dir, [first, app]] = repo([{ "app/mobile/App.tsx": "1" }, { "app/mobile/App.tsx": "2" }]);
  const older = { id: 1, event: "schedule", sha: first! };
  expect(due(dir, app!, [{ id: 2, event: "workflow_dispatch", sha: app!, steps: ["Archive", "Export"] }, older])[0]).toBe("build=true");
  expect(due(dir, app!, [{ id: 2, event: "workflow_dispatch", sha: app!, steps: ["Archive", "Upload to TestFlight"] }, older])[0]).toBe("build=false");
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
