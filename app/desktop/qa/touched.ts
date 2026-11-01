// `node qa/touched.ts <path>...`: the QA screens (registry.ts ids, comma-separated, for QA_SCREENS) that the changed
// paths (relative to app/desktop) show, so scripts/check.sh runs CI's own screens for them before a push: a screen that
// starts asking the hub something a fixture has no answer for fails only when it renders.
//
// - src/renderer/<file>: every screen whose id starts with the screens/<dir> of a file that imports it, directly or
//   through others (static, re-exported or lazy). The walk stops at screens/shell, which imports every screen: a chat
//   change runs chat*, not the whole app; a change in shell/ runs shell's own screens. Settings' pages are one level
//   finer: SettingsScreen imports each, and Projects.tsx (or a file it imports) runs settings.projects*. A page no
//   screen is named for (kebab-case, its directory's name for an index.ts, or PAGES) runs every settings screen.
// - fixtures/<group>/: the screens shown with the group's own fixtures, "<group>" and "<group>-<what>" (kit/group.ts).
//   What a group's extend adds to a shared fixture, and fixtures/kit, aren't followed: they'd pick nearly every screen.
//
// Prints nothing when no screen is picked; with --count, the number of tests (screen × fixture) instead.
import fs from "node:fs";
import path from "node:path";
import { screens } from "./registry.ts";

const APP = path.resolve(import.meta.dirname, "..");
const RENDERER = path.join(APP, "src/renderer");
const SETTINGS = path.join(RENDERER, "screens/settings/SettingsScreen.tsx");
const args = process.argv.slice(2);
const count = args.includes("--count");
const changed = args.filter((a) => a !== "--count").map((p) => path.resolve(APP, p));

const sources = fs
  .readdirSync(RENDERER, { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && /\.tsx?$/u.test(e.name) && !/\.test\.tsx?$/u.test(e.name))
  .map((e) => path.join(e.parentPath, e.name));
const resolve = (from: string, spec: string) => {
  const base = path.resolve(path.dirname(from), spec);
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")].find((p) =>
    fs.statSync(p, { throwIfNoEntry: false })?.isFile(),
  );
};
/** Each file, by the files that import it. */
const importers = new Map<string, Set<string>>();
for (const file of sources) {
  const text = fs.readFileSync(file, "utf8");
  for (const [, spec] of text.matchAll(/(?:^\s*(?:import|export)\s[^"';]*|\bimport\()["'](\.{1,2}\/[^"']+)["']/gmu)) {
    const to = resolve(file, spec ?? "");
    if (to !== undefined) importers.set(to, (importers.get(to) ?? new Set()).add(file));
  }
}
/** The screens/<dir> a file is in, if any. */
const dirOf = (file: string) => /^screens\/([^/]+)\//u.exec(path.relative(RENDERER, file))?.[1];
const ids = new Set(screens.map((s) => s.id));
/** The screen id prefixes picked: a screen is picked when its id is one, or starts with one and a ".". */
const prefixes = new Set<string>();
/** Settings' pages whose screens aren't named for their file. */
const PAGES: Record<string, string> = { Memory: "your-memory", ImportMemory: "your-memory", HubPages: "hub" };
/** The settings.* screens a settings page shows, by its file: none when no screen is named for it. */
const pageOf = (page: string) => {
  const name = path.basename(page).replace(/\.tsx?$/u, "");
  const file = name === "index" ? path.basename(path.dirname(page)) : name;
  const id = `settings.${PAGES[file] ?? file.replace(/(?<=[a-z0-9])(?=[A-Z])/gu, "-").toLowerCase()}`;
  return [...ids].some((i) => i === id || i.startsWith(`${id}.`)) ? id : undefined;
};

const groups = new Set<string>();
for (const file of changed) {
  const rel = path.relative(APP, file);
  const group = /^fixtures\/([^/]+)\//u.exec(rel)?.[1];
  if (group !== undefined && group !== "kit") groups.add(group);
  if (!rel.startsWith("src/renderer/") || /\.test\.tsx?$/u.test(rel)) continue;
  const inScreen = dirOf(file) !== undefined && dirOf(file) !== "shell";
  const seen = new Set<string>();
  for (const queue: Array<[string, string | undefined]> = [[file, undefined]]; queue.length > 0; ) {
    const [at, from] = queue.pop() as [string, string | undefined];
    // Settings' page switch, reached once by each page the change is in: that page's screens. Reached from what isn't
    // a page, only the change itself (the sidebar, parts.tsx) or a change to SettingsScreen picks every settings screen;
    // a page's file that the sidebar's search also imports still picks only its own.
    if (at === SETTINGS) {
      const page = from === undefined ? undefined : pageOf(from);
      if (page !== undefined) prefixes.add(page);
      else if (from === undefined || from === file) prefixes.add("settings");
    }
    if (seen.has(at)) continue;
    seen.add(at);
    const dir = dirOf(at);
    if (dir === "shell" && inScreen) continue;
    if (dir !== undefined && dir !== "settings") prefixes.add(dir);
    for (const by of importers.get(at) ?? []) queue.push([by, at]);
  }
}

const picked = screens.filter(
  (s) =>
    [...prefixes].some((p) => s.id === p || s.id.startsWith(`${p}.`)) ||
    s.fixtures.some((f) => [...groups].some((g) => f === g || f.startsWith(`${g}-`))),
);
const pickedIds = new Set(picked.map((s) => s.id));
// QA_SCREENS runs every screen with a picked id, whichever picked it.
if (count) console.log(screens.filter((s) => pickedIds.has(s.id)).reduce((n, s) => n + s.fixtures.length, 0));
else if (pickedIds.size > 0) console.log([...pickedIds].join(","));
