// Sets up, idempotently, the lab's GitHub repo (default `unlaboredlabs/fleetd-lab`, which must already exist) and
// clones it into the lab. Every slot shares the one repo and works in its own branch namespace (m7Train.ts NAMESPACE):
// - main holds the seed: a README and a GitHub Actions workflow `ci` whose one check, `ci`, fails iff a file `FAIL`
//   exists at the root, and runs for every PR except those into `noci/**`; the `seed` tag marks it, and the lab resets
//   a namespace's main to it after each run;
// - squash merges only, branches deleted on merge;
// - rulesets: `slot/*/main` (and main) require the checks `ci` and `fleetd/train`, `noci/*/main` only `fleetd/train`.
//   Repo admins may bypass them, so the lab can reset a namespace's main to the seed.
//
//   node tests/lab/labRepo.ts [--repo unlaboredlabs/fleetd-lab] [--clone ~/src/fleetd-lab/lab-repo]
//
// Uses the `gh` login on this machine. It only ever touches the one repo it is given, and never creates one.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    repo: { type: "string", default: "unlaboredlabs/fleetd-lab" },
    clone: { type: "string", default: path.join(os.homedir(), "src/fleetd-lab/lab-repo") },
  },
});
const repo = args.repo;
const clone = path.resolve(args.clone);
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u.test(repo)) throw new Error(`--repo must be owner/name, got ${repo}`);

const SEED_TAG = "seed";
const README = `# fleetd-lab

A disposable sandbox for fleetd's lab tests. Only fleetd's merge train merges here. Each lab slot works in its own
branch namespace:

- \`slot/<n>/main\` is the slot's base. It requires the \`ci\` check and the \`fleetd/train\` status, squash merges only.
- \`noci/<n>/main\` is a base with no CI: it requires only \`fleetd/train\`, and \`ci\` never runs for PRs into it.

Task branches live in the namespace too (\`slot/<n>/fleetd/...\`). After a run the lab closes the namespace's PRs,
deletes its branches and resets its main to the \`seed\` tag.

CI fails iff a file named \`FAIL\` exists at the repo root.
`;
const WORKFLOW = `name: ci

on:
  pull_request:
    branches-ignore: ["noci/**"]
  push:
    branches: [main, "slot/*/main"]

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

// 1. The repo itself, which this script never creates.
if (!gh("repo", "view", repo, "--json", "name").ok) throw new Error(`${repo} does not exist or is not readable; create it first (public, so GitHub enforces rulesets on a free plan)`);
const visibility = (ghJson("api", `repos/${repo}`) as { visibility: string }).visibility;
// Public since 2026-10-17 (owner's call) so GitHub enforces the rulesets on a free plan. It must hold nothing but
// throwaway test content: no secrets, no personal data.
if (visibility !== "public") console.warn(`${repo} is ${visibility}; GitHub enforces rulesets on free-plan repos only when public`);

// 2. Squash merges only, branches deleted on merge.
gh(
  "api", "-X", "PATCH", `repos/${repo}`,
  "-F", "allow_squash_merge=true", "-F", "allow_merge_commit=false", "-F", "allow_rebase_merge=false",
  "-F", "delete_branch_on_merge=true",
);

// 3. The rulesets, created or brought back to this shape.
const ADMIN_BYPASS = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
const PULL_REQUEST = {
  type: "pull_request",
  parameters: {
    required_approving_review_count: 0,
    dismiss_stale_reviews_on_push: false,
    require_code_owner_review: false,
    require_last_push_approval: false,
    required_review_thread_resolution: false,
    allowed_merge_methods: ["squash"],
  },
};
const checks = (...contexts: string[]) => ({
  type: "required_status_checks",
  parameters: { strict_required_status_checks_policy: false, required_status_checks: contexts.map((context) => ({ context })) },
});
const rulesets = [
  { name: "lab main", include: ["refs/heads/main"], rules: [{ type: "deletion" }, { type: "non_fast_forward" }, PULL_REQUEST, checks("ci", "fleetd/train")] },
  { name: "lab slots", include: ["refs/heads/slot/*/main"], rules: [PULL_REQUEST, checks("ci", "fleetd/train")] },
  { name: "lab noci", include: ["refs/heads/noci/*/main"], rules: [PULL_REQUEST, checks("fleetd/train")] },
];
// GitHub refuses rulesets on private repos on a free plan (HTTP 403); the rest is still set up and the train still
// merges pinned with its fleetd/train status, just unenforced.
let rulesetMissing: string | undefined;
const listed = gh("api", `repos/${repo}/rulesets`);
if (!listed.ok) {
  rulesetMissing = listed.stderr.trim();
} else {
  const existing = JSON.parse(listed.stdout) as ReadonlyArray<{ id: number; name: string }>;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-ruleset-"));
  try {
    for (const r of rulesets) {
      const body = path.join(dir, "ruleset.json");
      const ruleset = { name: r.name, target: "branch", enforcement: "active", conditions: { ref_name: { include: r.include, exclude: [] } }, bypass_actors: ADMIN_BYPASS, rules: r.rules };
      fs.writeFileSync(body, JSON.stringify(ruleset));
      const id = existing.find((e) => e.name === r.name)?.id;
      const saved = id === undefined
        ? gh("api", "-X", "POST", `repos/${repo}/rulesets`, "--input", body)
        : gh("api", "-X", "PUT", `repos/${repo}/rulesets/${id}`, "--input", body);
      if (saved.ok) console.log(`ruleset ${r.name} ${id === undefined ? "created" : "updated"}`);
      else rulesetMissing = saved.stderr.trim();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 4. The seed on main and its tag, unless the tag exists. Admins bypass main's ruleset.
if (gh("api", `repos/${repo}/git/ref/tags/${SEED_TAG}`).ok) {
  console.log(`tag ${SEED_TAG} exists`);
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-lab-seed-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "remote", "add", "origin", `https://github.com/${repo}.git`);
    const hasMain = spawnSync("git", ["fetch", "-q", "origin", "main"], { cwd: dir }).status === 0;
    if (hasMain) git(dir, "reset", "-q", "FETCH_HEAD");
    // Only the seed's files: what earlier runs merged into main stays in its history, not in the seed.
    git(dir, "rm", "-q", "-r", "--cached", "--ignore-unmatch", ".");
    fs.writeFileSync(path.join(dir, "README.md"), README);
    fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), WORKFLOW);
    git(dir, "add", "README.md", ".github/workflows/ci.yml");
    git(dir, "commit", "-q", "-m", "chore: the lab seed: a ci check that fails iff FAIL exists, never on noci/**");
    git(dir, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(dir, "push", "-q", "origin", `HEAD:refs/tags/${SEED_TAG}`);
    console.log(`pushed the seed to main and tagged it ${SEED_TAG}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 5. The lab clone.
if (fs.existsSync(path.join(clone, ".git"))) {
  git(clone, "fetch", "-q", "--tags", "origin");
  console.log(`${clone} exists; fetched`);
} else {
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  execFileSync("git", ["clone", "-q", `https://github.com/${repo}.git`, clone], { stdio: "inherit" });
  console.log(`cloned into ${clone}`);
}

if (rulesetMissing !== undefined) {
  console.log(
    /Upgrade to GitHub Pro/u.test(rulesetMissing)
      ? "rulesets skipped: private repo on a free plan — make it public or upgrade, then re-run"
      : `rulesets skipped: ${rulesetMissing}`,
  );
}
