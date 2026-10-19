// `pnpm fixtures`: writes fixtures/<name>.json, the files FLEETD_FIXTURE=<name> loads (src/main/hub/fixture.ts).
// The shared fixtures come from kit/shared.ts, every fixtures/<group>/index.ts may extend them and add its own, and
// every payload is checked against the hub's JSON Schemas. Any problem fails the build; nothing is half-written.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Fixture } from "./kit/fixture.ts";
import { type FixtureGroup, SHARED, type SharedName } from "./kit/group.ts";
import { validateFixture } from "./kit/schema.ts";
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

const names = new Set<string>();
const problems: Array<string> = [];
for (const f of all) {
  if (names.has(f.name)) problems.push(`two fixtures are named ${f.name}`);
  names.add(f.name);
  problems.push(...validateFixture(f));
}
if (problems.length > 0) {
  for (const p of problems.slice(0, 40)) console.error(p);
  console.error(`${problems.length} problems; no fixture written.`);
  process.exit(1);
}

// Only build output lives at the top level, so anything not rebuilt is stale.
for (const file of fs.readdirSync(DIR)) if (file.endsWith(".json") && !names.has(file.slice(0, -5))) fs.rmSync(path.join(DIR, file));
for (const f of all) {
  const pending = [...f.pendingContracts].map(([tool, why]) => ` (${tool} unchecked: ${why})`).join("");
  fs.writeFileSync(path.join(DIR, `${f.name}.json`), JSON.stringify(f.toFile()));
  console.log(`${f.name}${pending}`);
}
