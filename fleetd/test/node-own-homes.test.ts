// Kept browser profiles move at the node's start from where they were before D310 to `browser/kept/<id>`
// (own_homes.ts `moveKeptProfiles`, D500): every profile whole in one place, at every step, again and again.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keptDir } from "../src/node/actions/signins.ts";
import { startupCleanups } from "../src/node/index.ts";
import { moveKeptProfiles, oldProfilesDir } from "../src/node/own_homes.ts";
import { tempHome } from "./helpers.ts";

const homes: { done(): void }[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.done();
});

function profile(dir: string, cookie: string): void {
  mkdirSync(join(dir, "Default"), { recursive: true });
  writeFileSync(join(dir, "Default", "Cookies"), cookie);
}
const cookie = (dir: string) => readFileSync(join(dir, "Default", "Cookies"), "utf8");

function home() {
  const h = tempHome();
  homes.push(h);
  return { dir: h.dir, old: oldProfilesDir(h.dir), kept: join(h.dir, "browser", "kept") };
}

test("a node's start moves each kept profile, its sign-ins with it, and a second start finds nothing to move", () => {
  const h = home();
  profile(join(h.old, "ada"), "ada=1");
  profile(join(h.old, "bee"), "bee=1");
  startupCleanups(h.dir);
  expect([cookie(join(h.kept, "ada")), cookie(join(h.kept, "bee"))]).toEqual(["ada=1", "bee=1"]);
  expect(existsSync(h.old)).toBe(false);
  expect(keptDir(h.dir, "ada")).toBe(join(h.kept, "ada"));
  expect(moveKeptProfiles(h.dir)).toEqual([]);
  expect(cookie(join(h.kept, "ada"))).toBe("ada=1");
});

test("the old profile wins over one already at the new place: the browser used it; the other goes once it is in", () => {
  const h = home();
  profile(join(h.old, "ada"), "used");
  profile(join(h.kept, "ada"), "stale");
  expect(moveKeptProfiles(h.dir)).toEqual(["ada"]);
  expect(cookie(join(h.kept, "ada"))).toBe("used");
  expect(existsSync(join(h.kept, ".ada.stale"))).toBe(false);
});

test("a start stopped halfway is finished by the next: nothing lost, never both", () => {
  const h = home();
  profile(join(h.old, "ada"), "used");
  profile(join(h.kept, "ada"), "stale");
  // Stopped right after setting the stale one aside: the old one is still the project's.
  renameSync(join(h.kept, "ada"), join(h.kept, ".ada.stale"));
  expect(keptDir(h.dir, "ada")).toBe(join(h.old, "ada"));
  expect(moveKeptProfiles(h.dir)).toEqual(["ada"]);
  expect(cookie(join(h.kept, "ada"))).toBe("used");
  expect(existsSync(join(h.kept, ".ada.stale"))).toBe(false);
  // Stopped right after the move, before the stale one went: the next start removes it.
  profile(join(h.kept, ".bee.stale"), "stale");
  profile(join(h.kept, "bee"), "used");
  expect(moveKeptProfiles(h.dir)).toEqual([]);
  expect(existsSync(join(h.kept, ".bee.stale"))).toBe(false);
  expect(cookie(join(h.kept, "bee"))).toBe("used");
});

test("a profile a browser still runs on stays where it is, still the project's, and moves at a start that finds it free", () => {
  const h = home();
  profile(join(h.old, "ada"), "used");
  symlinkSync("devbox-4242", join(h.old, "ada", "SingletonLock"));
  expect(moveKeptProfiles(h.dir, (pid) => pid === 4242)).toEqual([]);
  expect(keptDir(h.dir, "ada")).toBe(join(h.old, "ada"));
  expect(moveKeptProfiles(h.dir, () => false)).toEqual(["ada"]);
  expect(cookie(join(h.kept, "ada"))).toBe("used");
});
