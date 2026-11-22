// Every "Settings › …" path the hub, the node and the CLI write for a person (an error's fix, a lead's line, a
// doctor's check) names pages the apps' Settings has, by the names its index shows (app/desktop/src/shared/
// settingsPages.ts, which the index takes its labels from). The apps' own lines are held to it by settingsPages.test.ts.
import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readableLines, settingsPathProblems } from "../../app/desktop/src/shared/settingsPathCheck.ts";
import { noMacFix } from "../src/hub/machine_roles/calls.ts";
import { signedOutLine } from "../src/hub/leads/cut_off.ts";
import { PEOPLE_ONLY } from "../src/hub/projects/people_only.ts";
import { runnerNoProvider } from "../src/node/place/index.ts";
import { settingsPath, setSettingsFlavour } from "../src/shared/settings_path.ts";

const SRC = join(import.meta.dir, "..", "src");
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".ts") ? [path] : [];
  });

test("the hub's Settings paths name pages the apps' Settings has", () => {
  const found = sources(SRC).flatMap((path) =>
    readableLines(readFileSync(path, "utf8")).flatMap((line) => settingsPathProblems(line).map((p) => `${path.slice(SRC.length + 1)}: ${p}`)),
  );
  expect(found).toEqual([]);
});

afterEach(() => setSettingsFlavour("hub"));

// The admins' group is a self-hosted hub's Hub and a fleetd cloud team's Team: fleetd's lines take it from
// shared/settings_path.ts, which fleetd cloud sets as it starts, and never write it themselves.
test("no line of fleetd's writes Settings › Hub itself: every one takes the group from settingsPath", () => {
  const found = sources(SRC)
    .filter((path) => !path.endsWith("shared/settings_path.ts"))
    .flatMap((path) => readableLines(readFileSync(path, "utf8")).filter((line) => line.includes("Settings › Hub")).map((line) => `${path.slice(SRC.length + 1)}: ${line.trim().slice(0, 120)}`));
  expect(found).toEqual([]);
});

test("on fleetd cloud, the lines fleetd builds name Settings › Team, never Settings › Hub; a self-hosted hub keeps Hub", () => {
  const lines = () => [signedOutLine({ kind: "hub" }), noMacFix(), PEOPLE_ONLY.mcp_servers, runnerNoProvider(), settingsPath("Machines")];
  expect(lines().every((l) => l.includes("Settings › Hub"))).toBe(true);
  setSettingsFlavour("team");
  expect(lines().filter((l) => l.includes("Settings › Hub"))).toEqual([]);
  expect(lines().every((l) => l.includes("Settings › Team"))).toBe(true);
  expect(signedOutLine({ kind: "hub" })).toContain("an admin replaces it in Settings › Team › Setup › Claude.");
  expect(lines().flatMap(settingsPathProblems)).toEqual([]);
});

