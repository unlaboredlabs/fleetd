// A hub runs each migration it hasn't by name, and only warns about one that changed after it ran, so a PR only adds
// new ones, never edits, renames or removes one on its base, and each sorts after every one there, so every hub runs
// them in the order a fresh one does. fleetd/scripts/gen.ts fails on a duplicate prefix. The one edit allowed: a file
// rewritten to run on an older SQLite with the same result, whose shipped SHA-256 migrations.ts's REWRITTEN lists, so a
// hub that ran it reads no drift.
// Run by CI's fleetd job on a PR, from the repo root: node .github/migrations-check.mjs <base commit> [<head>]
// CI names HEAD^1, the merge commit's first parent, so the base is exactly the one the tree under test was built on.
// <head> is HEAD (CI's merge commit) unless named: scripts/check.sh names its worktree merged onto origin/main.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const DIR = "fleetd/src/hub/store/migrations/";
const [base, head = "HEAD"] = process.argv.slice(2);
if (!base) throw new Error("usage: node .github/migrations-check.mjs <base commit> [<head>]");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).split("\n").filter((line) => line !== "");
const prefix = (name) => Number(name.split("_")[0]);

const shipped = git("ls-tree", "--name-only", base, DIR).map((path) => path.slice(DIR.length));
// The PR that split the old list into files adds them all.
if (shipped.length === 0) process.exit(0);
const last = shipped.reduce((a, b) => (prefix(a) > prefix(b) ? a : b), "0_");
const runner = execFileSync("git", ["show", `${head}:fleetd/src/hub/store/migrations.ts`], { encoding: "utf8" });
const rewritten = (name) => {
  const shipped = execFileSync("git", ["show", `${base}:${DIR}${name}`]);
  const sha = createHash("sha256").update(shipped).digest("hex");
  return runner.includes(`"${name.replace(/\.sql$/u, "")}": "${sha}"`);
};
const problems = [];
for (const line of git("diff", "--name-status", "--no-renames", base, head, "--", DIR)) {
  const [status, path] = line.split("\t");
  const name = path.slice(DIR.length);
  if (status === "M" && rewritten(name)) {
    continue;
  } else if (status !== "A") {
    problems.push(`${name}: shipped migrations are never edited, renamed or removed; add a new one instead`);
  } else if (!/^\d{12}_[a-z0-9_]+\.sql$/u.test(name)) {
    problems.push(`${name}: a new migration is named YYYYMMDDHHMM_snake_case_name.sql`);
  } else if (prefix(name) <= prefix(last)) {
    problems.push(`${name}: sorts before ${last}, already on the base; rename it to the current UTC time`);
  }
}
if (problems.length > 0) {
  console.error(`hub migrations:\n${problems.join("\n")}`);
  process.exit(1);
}
