// A hub's user_version counts the migrations it ran, in the order of their file names, so a PR only adds new ones,
// each sorting after every one on its base, and never edits, renames or removes one there. build.rs fails the build
// on a duplicate prefix.
// Run by CI's rust-lint job on a PR, from the repo root: node .github/migrations-check.mjs <base commit>
import { execFileSync } from "node:child_process";

const DIR = "crates/fleetd/src/hub/store/migrations/";
const base = process.argv[2];
if (!base) throw new Error("usage: node .github/migrations-check.mjs <base commit>");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).split("\n").filter((line) => line !== "");
const prefix = (name) => Number(name.split("_")[0]);

const shipped = git("ls-tree", "--name-only", base, DIR).map((path) => path.slice(DIR.length));
// The PR that split the old list into files adds them all.
if (shipped.length === 0) process.exit(0);
const last = shipped.reduce((a, b) => (prefix(a) > prefix(b) ? a : b), "0_");
const problems = [];
for (const line of git("diff", "--name-status", "--no-renames", base, "HEAD", "--", DIR)) {
  const [status, path] = line.split("\t");
  const name = path.slice(DIR.length);
  if (status !== "A") {
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
