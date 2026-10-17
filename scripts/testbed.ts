// Creates, idempotently, the merge-train testbed `unlaboredlabs/fleetd-testbed` and clones it into the lab:
// - a README and a GitHub Actions workflow `ci` whose one check, `ci`, fails iff a file `FAIL` exists at the root;
// - squash merges only;
// - a ruleset on main requiring the checks `ci` and `fleetd/train`, with no force-push and no deletion.
//
//   node scripts/testbed.ts [--repo unlaboredlabs/fleetd-testbed] [--clone /home/wynn/src/fleetd-lab/testbed]
//
// Uses the `gh` login on this machine. It only ever touches the one repo it is given.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    repo: { type: "string", default: "unlaboredlabs/fleetd-testbed" },
    clone: { type: "string", default: "/home/wynn/src/fleetd-lab/testbed" },
  },
});
const repo = args.repo;
const clone = path.resolve(args.clone);
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(repo)) throw new Error(`--repo must be owner/name, got ${repo}`);

const RULESET = "fleetd-train";
const README = `# fleetd-testbed

A disposable repo for fleetd's merge train tests. Only the train merges here: \`main\` requires the \`ci\` check and
the \`fleetd/train\` commit status, squash merges only.

CI fails iff a file named \`FAIL\` exists at the repo root.
`;
const WORKFLOW = `name: ci

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  ci:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v7
      - name: No FAIL file
        run: test ! -e FAIL
`;

/** `gh` with its exit status, so a 404 is an answer rather than an exception. */
const gh = (...argv: string[]) => {
  const out = spawnSync("gh", argv, { encoding: "utf8" });
  return { ok: out.status === 0, stdout: out.stdout, stderr: out.stderr };
};
const ghJson = (...argv: string[]): unknown => JSON.parse(execFileSync("gh", argv, { encoding: "utf8" }));
const git = (cwd: string, ...argv: string[]) => execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

// 1. The repo itself.
if (gh("repo", "view", repo, "--json", "name").ok) {
  console.log(`${repo} exists`);
} else {
  execFileSync("gh", ["repo", "create", repo, "--public", "--description", "fleetd merge train testbed (disposable)"], { stdio: "inherit" });
}
const visibility = (ghJson("api", `repos/${repo}`) as { visibility: string }).visibility;
// Public since 2026-10-17 (owner's call) so GitHub enforces the ruleset on a free plan. It must hold nothing but
// throwaway test content: no secrets, no personal data.
if (visibility !== "public") console.warn(`${repo} is ${visibility}; GitHub enforces rulesets on free-plan repos only when public`);

// 2. Squash merges only, branches deleted on merge.
gh(
  "api", "-X", "PATCH", `repos/${repo}`,
  "-F", "allow_squash_merge=true", "-F", "allow_merge_commit=false", "-F", "allow_rebase_merge=false",
  "-F", "delete_branch_on_merge=true",
);

// 3. The initial commit, unless main already exists.
if (gh("api", `repos/${repo}/branches/main`).ok) {
  console.log("main exists");
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-testbed-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(dir, "README.md"), README);
    fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), WORKFLOW);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "chore: testbed with a ci check that fails iff FAIL exists");
    git(dir, "push", "-q", `https://github.com/${repo}.git`, "main");
    console.log("pushed the initial commit to main");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 4. The ruleset on main, created or brought back to this shape.
const ruleset = {
  name: RULESET,
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  bypass_actors: [],
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
        allowed_merge_methods: ["squash"],
      },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: [{ context: "ci" }, { context: "fleetd/train" }],
      },
    },
  ],
};
// GitHub refuses rulesets on private repos on a free plan (HTTP 403); the rest is still set up and the train still
// merges pinned with its fleetd/train status, just unenforced.
let rulesetMissing: string | undefined;
const listed = gh("api", `repos/${repo}/rulesets`);
if (!listed.ok) {
  rulesetMissing = listed.stderr.trim();
} else {
  const existing = (JSON.parse(listed.stdout) as ReadonlyArray<{ id: number; name: string }>).find((r) => r.name === RULESET);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-ruleset-"));
  const body = path.join(dir, "ruleset.json");
  fs.writeFileSync(body, JSON.stringify(ruleset));
  const saved = existing === undefined
    ? gh("api", "-X", "POST", `repos/${repo}/rulesets`, "--input", body)
    : gh("api", "-X", "PUT", `repos/${repo}/rulesets/${existing.id}`, "--input", body);
  fs.rmSync(dir, { recursive: true, force: true });
  if (saved.ok) console.log(`ruleset ${RULESET} ${existing === undefined ? "created" : "updated"}`);
  else rulesetMissing = saved.stderr.trim();
}

// 5. The lab clone.
if (fs.existsSync(path.join(clone, ".git"))) {
  git(clone, "fetch", "-q", "origin");
  console.log(`${clone} exists; fetched`);
} else {
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  execFileSync("git", ["clone", "-q", `https://github.com/${repo}.git`, clone], { stdio: "inherit" });
  console.log(`cloned into ${clone}`);
}

if (rulesetMissing !== undefined) {
  console.log(
    /Upgrade to GitHub Pro/u.test(rulesetMissing)
      ? "ruleset skipped: private repo on a free plan — make it public or upgrade, then re-run"
      : `ruleset skipped: ${rulesetMissing}`,
  );
}
