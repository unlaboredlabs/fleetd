// What scripts/check.sh runs for a change, and what an earlier pass still covers. CI runs every job in full on its own
// runners and is the gate; this is the pre-push check's pick of the parts a change can break, so whenever it can't
// tell, it runs more.
//
//   bun scripts/check_scope.ts plan <tree> <base> <passes file>   the plan, as bash assignments (check.sh evals it)
//   bun scripts/check_scope.ts tests <path>...                    the fleetd tests the paths (repo-relative) reach
//
// The parts, from the changed files (as CI's jobs scope themselves):
// - fleetd: a change under .github/fleetd-scope.sh's paths. Its generated files, migrations and type check run whole;
//   its tests only those that reach a changed file (testsFor).
// - site: the docs build and every site check for a change to the site's own files; for a change to fleetd's paths
//   (`fleetd help`, the generated docs pages) all but the landing page's layout, which reads only site/'s pages.
// - desktop: app/desktop, ci.yml, and the hub files the app's tests read (ci.yml's desktop scope).
// - qa: app/desktop's renderer, fixtures and QA screens; app/desktop/qa/touched.ts picks the screens.
//
// A pass is "<tree> <base> <check>": the check passed on the tree, whose change is what it holds against the base (the
// merge base with origin/main then). It still covers a later tree when that tree is the pass's merged cleanly onto a
// newer main whose new commits touch none of the files the change held; then the check doesn't run. Otherwise only
// what the files it hasn't seen reach runs: the change's own new edits since the pass, and its files that main's new
// commits touched too (since).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const FLEETD = resolve(import.meta.dir, "..");
const REPO = resolve(FLEETD, "..");
export const CHECKS = ["fleetd", "site", "desktop", "qa"] as const;
export type Check = (typeof CHECKS)[number];

/** The site's own files: a change to one builds the docs and runs every site check. */
const SITE = ["docs/site", "site", ".github/site-check.mjs", ".github/site-layout-check.mjs", ".github/docs-links.mjs", ".github/docs-serve.mjs"];
/** ci.yml's desktop scope: the app, the workflow, and the hub's feature list and default prompts the app's tests read. */
const DESKTOP = ["app/desktop", ".github/workflows/ci.yml", "fleetd/src/hub/app_ws/server.ts", "fleetd/src/hub/prompts/defaults"];
/** What the QA screens show. */
const QA = ["app/desktop/src/renderer", "app/desktop/fixtures", "app/desktop/qa"];
/** What every fleetd test reads (the dependencies, Bun's and TypeScript's settings, the preload): a change runs all. */
const EVERY = ["fleetd/package.json", "fleetd/bun.lock", "fleetd/bunfig.toml", "fleetd/tsconfig.json", "fleetd/test/preload.ts"];
const CODE = /\.(?:ts|tsx|js|mjs|cjs)$/;
/** The files that wire a whole part of fleetd together, by that part: the CLI's entry, the node's, the hub's tools. */
const WIRING: Record<string, string> = {
  "fleetd/src/main.ts": "fleetd/src/cli",
  "fleetd/src/cli/index.ts": "fleetd/src/cli",
  "fleetd/src/node/index.ts": "fleetd/src/node",
  "fleetd/src/hub/api/registry.ts": "fleetd/src/hub",
  "fleetd/src/hub/api/hub.ts": "fleetd/src/hub",
};
const PARTS = [...new Set(Object.values(WIRING))];

const under = (paths: readonly string[]) => (p: string) => paths.some((s) => p === s || p.startsWith(`${s}/`));

/** .github/fleetd-scope.sh's `paths=( … )`, comments left out: what CI's fleetd job reads. */
export function scopePaths(repo = REPO): string[] {
  const text = readFileSync(join(repo, ".github/fleetd-scope.sh"), "utf8");
  const body = /\npaths=\(\n([\s\S]*?)\n\)\n/.exec(text)?.[1] ?? "";
  return body
    .split("\n")
    .flatMap((line) => line.replace(/#.*/, "").trim().split(/\s+/))
    .filter(Boolean);
}

/** What's at a path, if anything (a path through a file, as .git/info/exclude in a worktree, is nothing). */
function stat(p: string) {
  try {
    return statSync(p, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}
const isFile = (p: string) => stat(p)?.isFile() === true;
const isDir = (p: string) => stat(p)?.isDirectory() === true;

/** Every file under a folder, node_modules and dot folders left out (and not walked: app/desktop's are big). */
const listed = new Map<string, string[]>();
function filesIn(dir: string): string[] {
  let files = listed.get(dir);
  if (files === undefined) {
    files = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const at = join(dir, e.name);
      if (e.isFile()) files.push(at);
      else if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) files.push(...filesIn(at));
    }
    listed.set(dir, files);
  }
  return files;
}

/** The files a source names: its imports, and its strings that are a file's or a folder's path (a folder: its files),
 * from its own folder, fleetd/ or the repo's root. */
function named(file: string, repo: string): string[] {
  const fleetd = join(repo, "fleetd");
  // Comments left out: a doc comment's `.github/workflows` is prose. Only a block comment that starts its line: a
  // "src/**/*.ts" in a string isn't one.
  const text = readFileSync(file, "utf8")
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
  const out = new Set<string>();
  for (const [, spec] of text.matchAll(/["'`]([\w@+./-]*[./][\w@+./-]*)["'`]/g)) {
    if (!spec || /^[./]+$/.test(spec)) continue;
    for (const from of [dirname(file), fleetd, repo]) {
      const at = resolve(from, spec);
      if (!at.startsWith(`${repo}/`) || at.split("/").includes("node_modules")) continue;
      const hit = [at, `${at}.ts`, `${at}.tsx`, join(at, "index.ts")].find(isFile);
      if (hit) out.add(hit);
      // A folder that holds the source itself isn't one it reads by name: "B1/.." in a test under fleetd/test would
      // otherwise name every fixture there, and a fixture read by a name built at run time must run every test.
      else if (isDir(at) && at !== fleetd && !file.startsWith(`${at}/`) && !at.endsWith("/.git")) for (const f of filesIn(at)) out.add(f);
    }
  }
  out.delete(file);
  return [...out];
}

/** The fleetd tests, and each file they reach by the files that name it: walked from the tests down, each file read
 * once, and once a run. */
const graphs = new Map<string, { tests: string[]; namedBy: Map<string, Set<string>>; seen: Set<string> }>();
function graph(repo: string) {
  const known = graphs.get(repo);
  if (known) return known;
  const fleetd = join(repo, "fleetd");
  const tests = [...new Bun.Glob("test/**/*.test.ts").scanSync(fleetd)].map((t) => join(fleetd, t));
  const namedBy = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const queue = [...tests]; queue.length > 0; ) {
    const at = queue.pop()!;
    if (seen.has(at)) continue;
    seen.add(at);
    if (!CODE.test(at)) continue;
    for (const to of named(at, repo)) {
      if (!namedBy.has(to)) namedBy.set(to, new Set());
      namedBy.get(to)!.add(at);
      if (!seen.has(to)) queue.push(to);
    }
  }
  const out = { tests, namedBy, seen };
  graphs.set(repo, out);
  return out;
}

/**
 * The fleetd tests to run for the changed paths (repo-relative): "all", or test files relative to fleetd/ (maybe none).
 *
 * A test runs when it reaches a changed file through what it names (its imports, a "../src/x.ts" or
 * join(ROOT, ".github/workflows")) and on through what those name in turn, but not through the wiring of another part
 * (WIRING): a node change runs the node's tests, not the CLI's golden outputs, which reach every module through
 * main.ts. Code outside those parts (src/shared, the contracts, the migrations, the tests' kits) is shared: the walk
 * goes through all wiring, so it runs everything that reads it. Every test runs for a change to what all of
 * them read (EVERY), and for a file no test reaches that way (a deleted one, or one read by a name built at run time: a
 * fixture, a glob), as which tests read it can't be told. A path outside fleetd's scope runs none, as in CI.
 */
export function testsFor(changed: readonly string[], repo = REPO): "all" | string[] {
  const mine = changed.filter(under(scopePaths(repo)));
  if (mine.length === 0) return [];
  if (mine.some((p) => EVERY.includes(p))) return "all";
  const fleetd = join(repo, "fleetd");
  const { tests, namedBy, seen } = graph(repo);
  const picked = new Set<string>();
  for (const path of mine) {
    const file = join(repo, path);
    if (!seen.has(file)) return "all";
    const part = PARTS.find((p) => path.startsWith(`${p}/`));
    const up = new Set<string>();
    for (const queue = [file]; queue.length > 0; ) {
      const at = queue.pop()!;
      if (up.has(at)) continue;
      up.add(at);
      const wires = WIRING[relative(repo, at)];
      if (at !== file && part !== undefined && wires !== undefined && wires !== part) continue;
      for (const by of namedBy.get(at) ?? []) queue.push(by);
    }
    for (const t of tests) if (up.has(t)) picked.add(relative(fleetd, t));
  }
  return [...picked].sort();
}

/** What each part runs for these changed files; a part they don't reach is left out. */
export type Parts = {
  /** Generated files, migrations, the type check, and these tests. */
  fleetd?: "all" | string[];
  /** "full": the docs build and every site check; "help": all but the layout check, for `fleetd help`'s commands. */
  site?: "full" | "help";
  desktop?: true;
  /** The changed files under app/desktop, relative to it, for qa/touched.ts. */
  qa?: string[];
};
export function partsFor(changed: readonly string[], repo = REPO): Parts {
  const parts: Parts = {};
  const fleetd = changed.filter(under(scopePaths(repo)));
  if (fleetd.length > 0) parts.fleetd = testsFor(fleetd, repo);
  if (changed.some(under(SITE))) parts.site = "full";
  else if (fleetd.length > 0) parts.site = "help";
  if (changed.some(under(DESKTOP))) parts.desktop = true;
  if (changed.some(under(QA))) parts.qa = changed.filter(under(["app/desktop"])).map((p) => p.slice("app/desktop/".length));
  return parts;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function tried(repo: string, ...args: string[]): string | undefined {
  try {
    return git(repo, ...args);
  } catch {
    return undefined;
  }
}
const files = (out: string | undefined) => (out ? out.split("\n").filter(Boolean) : []);

/** The files <tree> changes against <base> (a commit). */
export function changedFiles(repo: string, base: string, tree: string): string[] {
  return files(git(repo, "diff", "--name-only", "--no-renames", base, tree));
}

export type Pass = { tree: string; base: string; check: string };

/** The passes in check.sh's record (fleetd-checked), newest first: its "<tree> <base> <check>" lines. */
export function readPasses(file: string): Pass[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length === 3)
    .map(([tree, base, check]) => ({ tree: tree!, base: base!, check: check! }))
    .reverse();
}

/**
 * What <tree> (on <base>) holds that a pass on pass.tree (on pass.base) hasn't seen, or undefined when the pass can't
 * count for it at all: pass.base isn't <base> or an ancestor of it, or the pass's tree doesn't merge cleanly onto
 * <base>. The files: those where <tree> differs from that clean merge (the change's own edits since), and the change's
 * files that main's commits since pass.base touched too. None: <tree> is the pass's, merged cleanly onto a newer main
 * that touched none of its files, and every check that passed on it still counts.
 */
export function since(repo: string, pass: Pass, tree: string, base: string): string[] | undefined {
  if (pass.base !== base && tried(repo, "merge-base", "--is-ancestor", pass.base, base) === undefined) return undefined;
  const commit = tried(repo, "commit-tree", pass.tree, "-p", pass.base, "-m", "check.sh pass");
  if (commit === undefined) return undefined;
  // Exits 1 on a conflict, so `tried` gives undefined.
  const merged = tried(repo, "merge-tree", "--write-tree", `--merge-base=${pass.base}`, base, commit)?.split("\n")[0];
  if (!merged) return undefined;
  const main = new Set(changedFiles(repo, pass.base, base));
  const touched = changedFiles(repo, pass.base, pass.tree).filter((f) => main.has(f));
  return [...new Set([...changedFiles(repo, merged, tree), ...touched])].sort();
}

export type Plan = {
  /** The parts the whole change reaches: what the tree must have passed to be pushed. */
  needed: Check[];
  /** What to run now, for the parts no pass covers. */
  run: Parts;
  /** Each needed part an earlier pass covers whole, with that pass. */
  covered: Partial<Record<Check, Pass>>;
  /** Each part that runs only for what a pass hasn't seen: the pass, and those files. */
  narrowed: Partial<Record<Check, { pass: Pass; files: string[] }>>;
};

/** How many of a check's newest passes are tried. */
const TRIED = 5;

export function plan(repo: string, tree: string, base: string, passes: readonly Pass[]): Plan {
  const all = partsFor(changedFiles(repo, base, tree), repo);
  const needed = CHECKS.filter((c) => all[c] !== undefined);
  const out: Plan = { needed, run: {}, covered: {}, narrowed: {} };
  const unseen = new Map<string, string[] | undefined>();
  for (const check of needed) {
    let parts = all;
    for (const pass of passes.filter((p) => p.check === check).slice(0, TRIED)) {
      const at = `${pass.tree} ${pass.base}`;
      if (!unseen.has(at)) unseen.set(at, since(repo, pass, tree, base));
      const files = unseen.get(at);
      if (files === undefined) continue;
      parts = partsFor(files, repo);
      if (parts[check] === undefined) out.covered[check] = pass;
      else out.narrowed[check] = { pass, files };
      break;
    }
    if (parts[check] !== undefined) (out.run as Record<Check, unknown>)[check] = parts[check];
  }
  return out;
}

/** The plan as bash assignments for check.sh: needed=(…), covered=(…), run_<check>=…, fleetd_tests=(…), qa_files=(…), notes=(…). */
export function shell(p: Plan): string {
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  const list = (xs: readonly string[]) => `(${xs.map(q).join(" ")})`;
  const short = (pass: Pass) => pass.tree.slice(0, 12);
  const notes: string[] = [];
  for (const [check, pass] of Object.entries(p.covered)) {
    notes.push(`${check}: passed on ${short(pass!)}, which this tree is merged onto a newer main that touched none of the change's files, so it doesn't run again (scripts/check.sh ${check} runs it)`);
  }
  for (const [check, n] of Object.entries(p.narrowed)) {
    const some = n!.files.slice(0, 5).join(", ") + (n!.files.length > 5 ? `, and ${n!.files.length - 5} more` : "");
    notes.push(`${check}: passed on ${short(n!.pass)}; runs only for what it hasn't seen: ${some}`);
  }
  const lines = [`needed=${list(p.needed)}`, `covered=${list(Object.keys(p.covered))}`, `notes=${list(notes)}`];
  const { fleetd, site, desktop, qa } = p.run;
  if (fleetd !== undefined) lines.push("run_fleetd=1", `fleetd_tests=${list(fleetd === "all" ? ["all"] : fleetd.map((t) => `./${t}`))}`);
  if (site !== undefined) lines.push(`run_site=${site}`);
  if (desktop) lines.push("run_desktop=1");
  if (qa !== undefined) lines.push("run_qa=1", `qa_files=${list(qa)}`);
  return lines.join("\n");
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan" && args.length === 3) {
    const [tree, base, record] = args as [string, string, string];
    const repo = git(process.cwd(), "rev-parse", "--show-toplevel");
    console.log(shell(plan(repo, tree, base, readPasses(record))));
  } else if (command === "tests") {
    const picked = testsFor(args);
    console.log(picked === "all" ? "all" : picked.join("\n"));
  } else {
    console.error("usage: bun scripts/check_scope.ts plan <tree> <base> <passes file> | tests <path>...");
    process.exit(2);
  }
}
