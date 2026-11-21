import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { label, screens } from "./registry.ts";

const APP = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(APP, "qa/registry.ts"), "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "touched-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (args: string[], input?: string, env?: Record<string, string>) =>
  execFileSync("git", args, { cwd: APP, encoding: "utf8", input, env: { ...process.env, ...env } }).trim();
/** A tree whose qa/registry.ts is this one edited: a base for touched.ts to compare the worktree's against. */
const base = (edit: (registry: string) => string) => {
  const index = { GIT_INDEX_FILE: path.join(tmp, `index-${String(Math.random())}`) };
  const blob = git(["hash-object", "-w", "--stdin"], edit(source));
  git(["update-index", "--add", "--cacheinfo", `100644,${blob},${git(["rev-parse", "--show-prefix"])}qa/registry.ts`], undefined, index);
  return git(["write-tree"], undefined, index);
};
/** touched.ts's picked tests' titles, from its --grep regex. */
const touched = (...args: string[]) => {
  const out = execFileSync("node", ["qa/touched.ts", ...args], { cwd: APP, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return out === "" ? [] : out.replace(/^\(\?:|\)\$$/gu, "").replace(/\\(.)/gu, "$1").split("|").sort();
};
const testsOf = (pick: (s: (typeof screens)[number]) => boolean) =>
  screens.filter(pick).flatMap((s) => s.fixtures.map((f) => `${label(s)} · ${f}`)).sort();

// fleetd #1828: Paper's screens moved from the bot page to Settings › Vault, a change to registry.ts alone, and the
// pre-push check picked none of them; they first ran, and failed, on CI.
const paper = (s: (typeof screens)[number]) => /^integrations-paper(?:-connect)?$/u.test(s.variant ?? "");
// The base has them on another page, and a fixture the move dropped.
const moved = base((registry) =>
  registry
    .replace(/(variant: "integrations-paper(?:-connect)?",\n\s*route: )"[^"]+"/gu, '$1"#/settings/projects?for=devbox/elsewhere"')
    .replace("export const fixtures = [\n", 'export const fixtures = [\n  "integrations-paper-old",\n'),
);

describe("touched.ts on the QA screens' own files", () => {
  it("picks the screens whose registry entries moved, and only those", () => {
    expect(screens.filter(paper)).toHaveLength(2);
    expect(touched(`--base=${moved}`, "qa/registry.ts")).toEqual(testsOf(paper));
    expect(touched(`--base=${moved}`, "--count", "qa/registry.ts")).toEqual([String(testsOf(paper).length)]);
  });

  it("keeps them with --near while they are within --most, and drops them past it", () => {
    expect(touched(`--base=${moved}`, "--near", "--most=150", "qa/registry.ts")).toEqual(testsOf(paper));
    expect(touched(`--base=${moved}`, "--near", "--most=1", "qa/registry.ts")).toEqual([]);
  });

  it("picks the screens whose code calls a registry helper that changed", () => {
    const at = base((registry) => registry.replace("Notification.isSupported = () => ok;", "Notification.isSupported = () => !ok;"));
    const calls = testsOf((s) => `${String(s.open)}${String(s.check)}`.includes("systemNotifications"));
    expect(calls.length).toBeGreaterThan(0);
    expect(touched(`--base=${at}`, "qa/registry.ts")).toEqual(calls);
    // ...but not with --near: they're the helper's, not their own.
    expect(touched(`--base=${at}`, "--near", "qa/registry.ts")).toEqual([]);
  });

  it("picks the screens whose code names what a changed helper file gives the registry", () => {
    const scroll = testsOf((s) => /\b(?:notches|scrollMoves|watchScroll)\b/u.test(`${String(s.open)}${String(s.check)}`));
    expect(scroll.length).toBeGreaterThan(0);
    expect(touched("qa/scroll.ts")).toEqual(scroll);
  });

  it("picks nothing for an unchanged registry, or for what every screen runs", () => {
    expect(touched(`--base=${base((r) => r)}`, "qa/registry.ts")).toEqual([]);
    expect(touched("qa/harness.ts", "qa/screens.spec.ts", "qa/dom/checks.ts")).toEqual([]);
  });

  it("still picks a fixture group's screens", () => {
    expect(touched("fixtures/integrations/index.ts")).toEqual(testsOf(() => true).filter((t) => / · integrations(?:-.+)?$/u.test(t)));
  });
});
