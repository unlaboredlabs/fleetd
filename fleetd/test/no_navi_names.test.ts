// Navis are projects (D310) and their names are gone (D317, D327). site/.stale-terms holds the site and the docs to
// that; this holds every other tracked file, so a comment or a name can't bring them back. "navigate" doesn't match.
import { expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const NAVI = /\bnavi(s|_\w+)?\b/i;
/** What may keep the name: applied migrations and their generated list, a recorded run, the term and the redirect
 * that keep old words and links out, the node's on-disk `navis` directory (D500), and this test. */
const KEPT = [
  /^fleetd\/src\/hub\/store\/migrations\//,
  /^fleetd\/src\/gen\/migrations\.ts$/,
  /^fleetd\/src\/node\/own_homes\.ts$/,
  /^tests\/compare\/results\//,
  /^site\/\.stale-terms$/,
  /^site\/vercel\.json$/,
  /^fleetd\/test\/no_navi_names\.test\.ts$/,
];

test("no tracked file names a Navi outside what was kept", () => {
  const out = Bun.spawnSync(["git", "-C", ROOT, "grep", "-I", "-n", "-i", "-F", "navi"]);
  expect(out.exitCode === 0 || out.exitCode === 1).toBe(true);
  const hits = out.stdout
    .toString()
    .split("\n")
    .filter((line) => NAVI.test(line.slice(line.indexOf(":") + 1)))
    .filter((line) => !KEPT.some((path) => path.test(line.slice(0, line.indexOf(":")))));
  expect(hits).toEqual([]);
});
