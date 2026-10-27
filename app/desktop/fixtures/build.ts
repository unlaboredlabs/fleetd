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
for (const name of SHARED) get(name);
const base = (name: SharedName) => Fixture.from(get(name), name, get(name).note);

// Each fixture is finished, checked and written to STAGING as soon as it's built and then let go, so memory holds one
// group's fixtures at a time however many there are. The shared ones go last: every group's base() copies them as the
// kit and the groups' extend left them, before finish() syncs them. Only if all pass do the files move into place.
const STAGING = path.join(DIR, ".staging");
fs.rmSync(STAGING, { recursive: true, force: true });
fs.mkdirSync(STAGING);
const names = new Set<string>();
const problems: Array<string> = [];
const written: Array<string> = [];
const finish = (f: Fixture) => {
  // Last, after the group made it: one count of agents per project, whatever shows it (kit/agents.ts).
  syncAgents(f);
  syncProfiles(f);
  syncAgentsList(f);
  // The sidebar words why a lead waits on you from the hub's open requests: a hub always answers requests_list.
  if (f.snapshot !== undefined && f.answers("requests_list").length === 0) f.answer("requests_list", { limit: 100 }, { requests: [] });
  // The Agents tab reads the work elsewhere on the project's repo: nothing, unless a fixture says otherwise.
  if (f.snapshot !== undefined) f.answer("work_list", undefined, { scope: { repoKey: "github.com/acme/shop", base: "main" }, items: [], recentLandings: [] });
  // prompt_get lists without an id. Main matches inputs as subsets, so a project's list would answer a request for one
  // of its prompts: each hub-wide prompt answers for every listed project too, unless that project has its own.
  const prompts = f.answers("prompt_get");
  for (const list of prompts.filter((a) => a.input?.["id"] === undefined && a.input?.["projectRef"] !== undefined)) {
    for (const one of prompts.filter((a) => a.input?.["id"] !== undefined && a.input["projectRef"] === undefined)) {
      const input = { ...one.input, projectRef: list.input?.["projectRef"] ?? null };
      if (f.output("prompt_get", input) === undefined) f.answer("prompt_get", input, one.output);
    }
  }

  if (names.has(f.name)) problems.push(`two fixtures are named ${f.name}`);
  names.add(f.name);
  const found = validateFixture(f);
  const json = JSON.stringify(f.toFile());
  found.push(...findLeaks(json).map((leak) => `${f.name} leaks ${leak}`));
  problems.push(...found);
  if (found.length > 0) return;
  fs.writeFileSync(path.join(STAGING, `${f.name}.json`), json);
  // Main's own loader, so a file that builds is a file the app accepts.
  loadFixture(f.name, STAGING);
  const pending = [...f.pendingContracts].map(([tool, why]) => ` (${tool} unchecked: ${why})`).join("");
  written.push(`${f.name}${pending}`);
};
for (const [group, { fixtures }] of groups) {
  for (const f of fixtures?.(base) ?? []) {
    if (!f.name.startsWith(`${group}-`)) throw new Error(`fixtures/${group}: "${f.name}" must be named "${group}-<what>"`);
    finish(f);
  }
}
for (const name of SHARED) {
  finish(get(name));
  shared.delete(name);
}

// The committed recordings too: a hand edit must not bring back what the sanitizer took out.
const RECORDED = path.join(DIR, "recorded");
for (const file of fs.readdirSync(RECORDED).filter((x) => x.endsWith(".json"))) {
  problems.push(...findLeaks(fs.readFileSync(path.join(RECORDED, file), "utf8")).map((leak) => `recorded/${file} leaks ${leak}`));
}
if (problems.length > 0) {
  fs.rmSync(STAGING, { recursive: true, force: true });
  for (const p of problems.slice(0, 40)) console.error(p);
  console.error(`${problems.length} problems; no fixture written.`);
  process.exit(1);
}

// Only build output lives at the top level, so anything not rebuilt is stale.
for (const file of fs.readdirSync(DIR)) if (file.endsWith(".json") && !names.has(file.slice(0, -5))) fs.rmSync(path.join(DIR, file));
for (const name of names) fs.renameSync(path.join(STAGING, `${name}.json`), path.join(DIR, `${name}.json`));
fs.rmSync(STAGING, { recursive: true, force: true });
for (const line of written) console.log(line);
