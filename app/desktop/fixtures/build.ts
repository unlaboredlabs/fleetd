// `pnpm fixtures`: writes fixtures/<name>.json, the files FLEETD_FIXTURE=<name> loads (src/main/hub/fixture.ts).
// The shared fixtures come from kit/shared.ts, every fixtures/<group>/index.ts may extend them and add its own, and
// every payload is checked against the hub's JSON Schemas. Any problem fails the build; nothing is half-written.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Fixture } from "./kit/fixture.ts";
import { type FixtureGroup, SHARED, type SharedName } from "./kit/group.ts";
import { syncAgents, syncAgentsList, syncProfiles } from "./kit/agents.ts";
import { findLeaks } from "./kit/leaks.ts";
import { validateFixture } from "./kit/schema.ts";
import { loadFixture } from "../src/main/hub/fixture.ts";
import { buildShared } from "./kit/shared.ts";

const DIR = import.meta.dirname;
const NOT_GROUPS = new Set(["kit", "recorded"]);

const groups: Array<[string, FixtureGroup]> = [];
for (const entry of fs.readdirSync(DIR, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name))) {
  const index = path.join(DIR, entry.name, "index.ts");
  if (!entry.isDirectory() || NOT_GROUPS.has(entry.name) || !fs.existsSync(index)) continue;
  const mod = (await import(pathToFileURL(index).href)) as { default?: FixtureGroup };
  if (mod.default === undefined) throw new Error(`${index} has no default export; export default defineGroup({...})`);
  groups.push([entry.name, mod.default]);
}

const shared = buildShared();
for (const [group, { extend }] of groups) {
  for (const [name, add] of Object.entries(extend ?? {})) {
    const f = shared.get(name as SharedName);
    if (f === undefined) throw new Error(`fixtures/${group} extends "${name}", which is not a shared fixture (${SHARED.join(", ")})`);
    add(f);
  }
}
const get = (name: SharedName): Fixture => {
  const f = shared.get(name);
  if (f === undefined) throw new Error(`kit/shared.ts built no "${name}"`);
  return f;
};
const all: Array<Fixture> = SHARED.map(get);
const base = (name: SharedName) => Fixture.from(get(name), name, get(name).note);
for (const [group, { fixtures }] of groups) {
  for (const f of fixtures?.(base) ?? []) {
    if (!f.name.startsWith(`${group}-`)) throw new Error(`fixtures/${group}: "${f.name}" must be named "${group}-<what>"`);
    all.push(f);
  }
}

// Last, after every group: one count of agents per project, whatever shows it (kit/agents.ts).
for (const f of all) {
  syncAgents(f);
  syncProfiles(f);
  syncAgentsList(f);
  // The sidebar words why a lead waits on you from the hub's open requests: a hub always answers requests_list.
  if (f.snapshot !== undefined && f.answers("requests_list").length === 0) f.answer("requests_list", { limit: 100 }, { requests: [] });
}

const names = new Set<string>();
const problems: Array<string> = [];
const files = new Map<string, string>();
for (const f of all) {
  if (names.has(f.name)) problems.push(`two fixtures are named ${f.name}`);
  names.add(f.name);
  problems.push(...validateFixture(f));
  const json = JSON.stringify(f.toFile());
  problems.push(...findLeaks(json).map((leak) => `${f.name} leaks ${leak}`));
  files.set(f.name, json);
}
// The committed recordings too: a hand edit must not bring back what the sanitizer took out.
const RECORDED = path.join(DIR, "recorded");
for (const file of fs.readdirSync(RECORDED).filter((x) => x.endsWith(".json"))) {
  problems.push(...findLeaks(fs.readFileSync(path.join(RECORDED, file), "utf8")).map((leak) => `recorded/${file} leaks ${leak}`));
}
if (problems.length > 0) {
  for (const p of problems.slice(0, Number(process.env["FIXTURES_SHOW"] ?? 40))) console.error(p);
  console.error(`${problems.length} problems; no fixture written.`);
  process.exit(1);
}

// Only build output lives at the top level, so anything not rebuilt is stale.
for (const file of fs.readdirSync(DIR)) if (file.endsWith(".json") && !names.has(file.slice(0, -5))) fs.rmSync(path.join(DIR, file));
for (const f of all) {
  const pending = [...f.pendingContracts].map(([tool, why]) => ` (${tool} unchecked: ${why})`).join("");
  fs.writeFileSync(path.join(DIR, `${f.name}.json`), files.get(f.name) ?? "");
  // Main's own loader, so a file that builds is a file the app accepts.
  loadFixture(f.name, DIR);
  console.log(`${f.name}${pending}`);
}
