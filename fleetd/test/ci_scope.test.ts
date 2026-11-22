// ci.yml's `fleetd` job runs on a PR or the train's batch only when one of .github/fleetd-scope.sh's paths changed, but
// always on main: a file fleetd's code or tests read outside those paths lets a PR pass and then turn main red. #1884
// did (mac.yml's new job against .fleetd/train.json, read by repo.test.ts). This holds every file named outside fleetd/
// to the scope: a relative path that leaves fleetd/, or one joined onto a ROOT that is the repo's root.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const SCOPE = ".github/fleetd-scope.sh";
/** What reads the whole repo rather than a path: it can't be scoped, so a PR outside the paths isn't checked by it. */
const WHOLE_REPO = ["fleetd/test/no_navi_names.test.ts"];

/** The script's `paths=( … )`, comments left out. */
function scopePaths(): string[] {
  const text = readFileSync(join(REPO, SCOPE), "utf8");
  const body = /\npaths=\(\n([\s\S]*?)\n\)\n/.exec(text)?.[1];
  expect(body).toBeDefined();
  return body!
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .flatMap((line) => line.split(/\s+/))
    .filter(Boolean);
}

/** Each repo file or folder a source names outside fleetd/, with the source naming it. */
function namedOutside(): [string, string][] {
  const out: [string, string][] = [];
  for (const dir of ["src", "test", "scripts"]) {
    for (const f of new Bun.Glob("**/*.ts").scanSync(join(REPO, "fleetd", dir))) {
      const source = `fleetd/${dir}/${f}`;
      if (WHOLE_REPO.includes(source)) continue;
      const file = join(REPO, source);
      const text = readFileSync(file, "utf8");
      const paths = [...text.matchAll(/["'`]((?:\.\.\/)+[^"'`$\s]+)["'`]/g)].map((m) => resolve(dirname(file), m[1]!));
      const root = /const ROOT = (?:join|resolve)\(import\.meta\.dir, "([./]+)"\)/.exec(text)?.[1];
      if (root !== undefined && resolve(dirname(file), root) === REPO) {
        paths.push(...[...text.matchAll(/join\(ROOT, "([^"]+)"/g)].map((m) => join(REPO, m[1]!)));
      }
      for (const path of paths) {
        const rel = relative(REPO, path);
        if (rel === "" || rel.startsWith("..") || rel === "fleetd" || rel.startsWith("fleetd/") || !existsSync(path)) continue;
        out.push([rel, source]);
      }
    }
  }
  return out;
}

test("every file fleetd reads outside fleetd/ is in the fleetd job's scope, so a PR can't pass and main fail on it", () => {
  const scope = scopePaths();
  expect(scope).toContain("fleetd");
  const named = namedOutside();
  // The probe itself: repo.test.ts reads the workflows and the train's settings through ROOT.
  expect(named).toContainEqual([".github/workflows", "fleetd/test/repo.test.ts"]);
  const covered = (rel: string) => scope.some((p) => rel === p || rel.startsWith(`${p}/`));
  expect(named.filter(([rel]) => !covered(rel)).map(([rel, source]) => `${SCOPE} leaves out ${rel}, which ${source} reads`)).toEqual([]);
});
