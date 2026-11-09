import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENTRIES, entry, placeholdersOf } from "../src/hub/prompts/entry.ts";
import { gitBlobSha, merge, placeholdersIn, render } from "../src/hub/prompts/render.ts";
import { RETIRED } from "../src/hub/prompts/retired.ts";
import { prompts, promptsDir } from "../src/hub/prompts/store.ts";
import { openHubDb, tempHome } from "./helpers.ts";

test("refs are git blob SHAs, as the Rust hub makes them", () => {
  expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
});

test("the registry and the retired list are the Rust tables", () => {
  expect(ENTRIES.length + RETIRED.length).toBe(85);
  for (const r of RETIRED) {
    expect(ENTRIES.some((e) => e.id === r.id)).toBe(false);
    if (r.target) expect(ENTRIES.some((e) => e.id === r.target)).toBe(true);
  }
});

test("every shipped text uses what its entry declares", () => {
  for (const e of ENTRIES) {
    const declared = placeholdersOf(e);
    const used = placeholdersIn(e.default);
    for (const p of declared) if (p.required) expect(used).toContain(p.name);
    for (const name of used) expect(declared.map((p) => p.name)).toContain(name);
  }
});

test("render fills names it has and leaves the rest", () => {
  expect(render("a {{x}} {{y}} {{ bad}}\n", { x: "{{y}}" })).toBe("a {{y}} {{y}} {{ bad}}");
});

test("a line merge keeps both sides' changes and marks a clash", () => {
  expect(merge("a\nb\nc\n", "a\nb\nC\n", "A\nb\nc\n")).toEqual({ text: "A\nb\nC\n", conflicts: false });
  expect(merge("a\n", "b\n", "c\n").conflicts).toBe(true);
});

test("a project id never steers where an override is written", () => {
  const home = tempHome();
  const outside = tempHome();
  const db = openHubDb(home.dir);
  const p = prompts(db);
  const e = entry("lead.start");
  p.save(e, "global", undefined, "hub-wide");
  for (const id of ["../..", "..", join(outside.dir, "lead.start")]) {
    const r = { machineId: "lab-a", projectId: id };
    p.save(e, "project", r, "project");
    expect(p.overrideOf(e, r)?.text).toBe("project");
    p.reset(e, "project", r);
  }
  expect(p.overrideOf(e)?.text).toBe("hub-wide");
  expect(readdirSync(outside.dir).length).toBe(0);
  expect(existsSync(join(home.dir, "lead.start.md"))).toBe(false);
  db.close();
  home.done();
  outside.done();
});

test("a reflowed default is not a changed default", () => {
  const home = tempHome();
  const db = openHubDb(home.dir);
  const p = prompts(db);
  const e = entry("lead.start");
  const wrapped = e.default.replace(" and tell them only", "\nand tell them only");
  expect(wrapped).not.toBe(e.default);
  const older = e.default.replace("Trust it over your memory", "Trust it over what you recall");
  for (const [baseText, stale] of [
    [e.default, false],
    [wrapped, false],
    [older, true],
  ] as const) {
    const base = p.save(e, "global", undefined, baseText);
    p.save(e, "global", undefined, "mine {{project}} {{projectRef}}", base);
    expect(p.stale().length).toBe(stale ? 1 : 0);
    expect(p.detail(e).stale !== undefined).toBe(stale);
    expect(p.list().find((s) => s.id === e.id)?.stale).toBe(stale);
  }
  db.close();
  home.done();
});

test("a renamed prompt's edit under its old id still applies until reset", () => {
  const home = tempHome();
  const db = openHubDb(home.dir);
  const dir = promptsDir(db) as string;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "navi.start.md"), "---\nbase: navi.start@0123456789\n---\nYou are {{project}}, mine.");
  const e = entry("navi.start");
  expect(e.id).toBe("assistant.start");
  const p = prompts(db);
  const shown = () => p.current().render("assistant.start", { project: "Ada" });
  expect(shown().startsWith("You are Ada, mine.")).toBe(true);
  p.save(e, "global", undefined, "You are {{project}}, newer.");
  expect(shown().startsWith("You are Ada, newer.")).toBe(true);
  p.reset(e, "global");
  expect(existsSync(join(dir, "navi.start.md"))).toBe(false);
  expect(shown().startsWith("You are Ada, a personal assistant")).toBe(true);
  db.close();
  home.done();
});
