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
import { RUNNER_ID } from "../src/shared/sandbox.ts";
import { settingsPath, setSettingsFlavour } from "../src/shared/settings_path.ts";

const SRC = join(import.meta.dir, "..", "src");
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".ts") ? [path] : [];
  });

test("the workspace's Settings paths name pages the apps' Settings has", () => {
  const found = sources(SRC).flatMap((path) =>
    readableLines(readFileSync(path, "utf8")).flatMap((line) => settingsPathProblems(line).map((p) => `${path.slice(SRC.length + 1)}: ${p}`)),
  );
  expect(found).toEqual([]);
});

afterEach(() => setSettingsFlavour("hub"));

// The admins' group is Workspace, on a self-hosted workspace and on a fleetd cloud one alike (it was Hub and Team):
// fleetd's lines take it from shared/settings_path.ts, and never write it themselves.
test("no line of fleetd's writes Settings › Workspace itself: every one takes the group from settingsPath", () => {
  const found = sources(SRC)
    .filter((path) => !path.endsWith("shared/settings_path.ts"))
    .flatMap((path) => readableLines(readFileSync(path, "utf8")).filter((line) => line.includes("Settings › Workspace")).map((line) => `${path.slice(SRC.length + 1)}: ${line.trim().slice(0, 120)}`));
  expect(found).toEqual([]);
});

test("the lines fleetd builds name Settings › Workspace, on fleetd cloud too", () => {
  const lines = () => [signedOutLine({ kind: "hub" }), signedOutLine(undefined, RUNNER_ID), noMacFix(), PEOPLE_ONLY.mcp_servers, runnerNoProvider(), settingsPath("Machines")];
  expect(lines().every((l) => l.includes("Settings › Workspace"))).toBe(true);
  const selfHosted = lines();
  setSettingsFlavour("team");
  expect(lines()).toEqual(selfHosted);
  expect(signedOutLine({ kind: "hub" })).toContain("an admin replaces it in Settings › Workspace › Setup › Claude.");
  // A bot on fleetd's computers with no account has no machine to run `claude auth login` on: where an admin adds the key.
  expect(signedOutLine(undefined, RUNNER_ID)).toBe(
    "This bot has no Claude account to run on yet: an admin adds a Claude API key in Settings › Workspace › Providers › Anthropic. The lead carries on by itself once it is.",
  );
  expect(signedOutLine(undefined, "devbox")).toContain("`claude auth login`");
  expect(lines().flatMap(settingsPathProblems)).toEqual([]);
});

test("fleetd cloud still sets the flavour through the package's export, and fleetd's lines name Workspace there", async () => {
  // The cloud's way in: the root package.json's export, which must be the very module every line above reads.
  const root = join(import.meta.dir, "..", "..");
  const exported = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, string> }).exports["./shared/settings_path"];
  expect(exported).toBe("./fleetd/src/shared/settings_path.ts");
  const pkg = (await import(join(root, exported ?? ""))) as typeof import("../src/shared/settings_path.ts");
  pkg.setSettingsFlavour("team");
  expect(signedOutLine({ kind: "hub" })).toContain("Settings › Workspace › Setup › Claude");
  expect(settingsPath("Machines")).toBe("Settings › Workspace › Machines");
});
