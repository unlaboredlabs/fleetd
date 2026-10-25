// Settings' fixture data. The shared fixtures get what Settings asks beyond the recorded traffic (the projects for
// the pickers, the dry run, a prompt whose default changed), and `settings-prompts` is the whole real
// registry from the fake prompt hub: every prompt's real text, a hub-wide edit made against an older default (the
// 3-way Update view), a project's own edit, and the instructions at both levels.
import fs from "node:fs";
import { defineGroup, SHARED } from "../kit/group.ts";
import { Fixture } from "../kit/fixture.ts";
import { asText, clone, isObject, type JsonObject, type JsonValue } from "../kit/json.ts";
import { PROJECTS, PromptHub, type RegistryEntry } from "./promptHub.ts";

const registry = (
  JSON.parse(fs.readFileSync(new URL("../../src/renderer/screens/settings/fixture/registry.json", import.meta.url), "utf8")) as {
    prompts: RegistryEntry[];
  }
).prompts;

const json = (v: unknown): JsonValue => JSON.parse(JSON.stringify(v)) as JsonValue;

/** ProjectSummary in full, as the schema wants it. */
const projectSummary = (p: (typeof PROJECTS)[number]): JsonObject => ({
  machineId: p.machineId,
  projectId: p.projectId,
  title: p.title,
  workspaceRoot: `/home/dev/src/${p.projectId}`,
  threads: { running: 1, waiting: 0, idle: 2, failed: 0 },
  lastActivityAt: "2026-10-19T10:21:00.000Z",
});

/**
 * Each project's "medium allowed" switch as project_get reads it (on, unless named in `off`), and project_set's
 * answer either way.
 */
function projectSettings(f: Fixture, off: ReadonlySet<string> = new Set()) {
  const projects = isObject(f.snapshot) && Array.isArray(f.snapshot["projects"]) ? f.snapshot["projects"].filter(isObject) : [];
  for (const p of projects) {
    const ref = { machineId: asText(p["machineId"]), projectId: asText(p["projectId"]) };
    f.answer("project_get", ref, { asOf: f.now, project: clone(p), stale: false, threads: [], mediumAllowed: !off.has(ref.projectId) });
    for (const on of [true, false]) f.answer("project_set", { ...ref, mediumAllowed: on }, { mediumAllowed: on });
  }
}

/** What Settings calls besides the prompt reads. */
function basics(f: Fixture) {
  projectSettings(f);
  if (f.output("project_get") === undefined) f.answer("project_get", undefined, { projects: PROJECTS.map(projectSummary) });
  // The dry run, for any text: a fixture cannot know what will be typed, so it answers with no warnings.
  f.answer("prompt_set", { dryRun: true }, { ref: "lead.start@5e771ed000", warnings: [] });
}

/** Every shared fixture: what Settings calls besides the recorded prompt reads. */
const shared = (f: Fixture) => basics(f);

/** A machine's cap as the hub sizes it, and whether someone set it (`source`: what sets the cap). */
interface MachineCap {
  machineId: string;
  auto: number;
  why: string;
  cap: number;
  set: boolean;
  source: string;
  diskRoom: number;
}
/** A project's max: its own, or (`set` false) its machine's cap. */
interface ProjectMax {
  projectRef: JsonObject;
  maxAgents: number;
  running: number;
  queued: number;
  set: boolean;
}

/** The slot state the hub sends for these machines and projects; no fleet cap means the machines' caps added up. */
function slotState(fleetCap: number | undefined, machines: MachineCap[], projects: ProjectMax[]): JsonObject {
  const capOf = (p: ProjectMax) => machines.find((m) => m.machineId === p.projectRef["machineId"])?.cap ?? 0;
  const perProject = projects.map((p) => ({ ...clone(p as unknown as JsonObject), maxAgents: p.set ? p.maxAgents : capOf(p) }));
  const fits = machines.reduce((n, m) => n + m.cap, 0);
  const used = projects.reduce((n, p) => n + p.running, 0);
  const queued = projects.reduce((n, p) => n + p.queued, 0);
  const running = (m: MachineCap) => projects.filter((p) => p.projectRef["machineId"] === m.machineId).reduce((n, p) => n + p.running, 0);
  return {
    cap: fleetCap ?? fits,
    ...(fleetCap === undefined ? {} : { fleetCap }),
    used,
    queued,
    perProject,
    perMachine: machines.map((m) => ({ ...clone(m as unknown as JsonObject), running: running(m) })),
  };
}

/**
 * Max agents, sized by machine. devbox runs what its 32 GB fits (12), though its free disk has room for only 2 more
 * now; someone set buildbox to 8, above the 6 its 18 GB fits. storefront and checkout follow devbox's cap, and billing
 * has a max of its own, 3, which it sits at with 2 queued. `fleetCap`: a saved fleet cap (the lab's 40), else none.
 * The slot state is set in the snapshot and in every live frame that carries one, since the live state wins.
 */
function agents(from: Fixture, name: string, note: string, fleetCap?: number): Fixture {
  const f = Fixture.from(from, name, note);
  f.agentsFromSlots = true;
  const projects = isObject(f.snapshot) && Array.isArray(f.snapshot["projects"]) ? f.snapshot["projects"].filter(isObject) : [];
  const ref = (p: JsonObject): JsonObject => ({ machineId: asText(p["machineId"]), projectId: asText(p["projectId"]) });
  const machines: MachineCap[] = [
    { machineId: "devbox", auto: 12, why: "memory 32 GB", cap: 12, set: false, source: "memory", diskRoom: 2 },
    { machineId: "buildbox", auto: 6, why: "memory 18 GB", cap: 8, set: true, source: "set", diskRoom: 19 },
  ];
  const [first, second, third] = projects;
  const rows: ProjectMax[] = [];
  if (first) rows.push({ projectRef: ref(first), maxAgents: 12, running: 6, queued: 0, set: false });
  if (second) rows.push({ projectRef: ref(second), maxAgents: 3, running: 3, queued: 2, set: true });
  if (third) rows.push({ projectRef: ref(third), maxAgents: 12, running: 0, queued: 0, set: false });
  const slots = slotState(fleetCap, machines, rows);
  if (f.snapshot) f.snapshot["slots"] = clone(slots);
  for (const frame of f.live) if (frame["slots"] !== undefined) frame["slots"] = clone(slots);
  // A change answers with the slot state it asked for, as the hub does: every max each project can take, auto (and
  // the pause of the agents over it, which Undo's neighbour offers); every cap and auto for each machine; and every
  // fleet cap the slider reaches, and none.
  for (const row of rows) {
    const projectRef = row.projectRef;
    const answer = (maxAgents: number | "auto", out: JsonObject) => {
      f.answer("cap_set", { project: { projectRef: clone(projectRef), maxAgents } }, out);
      const top = machines.find((m) => m.machineId === projectRef["machineId"])?.cap ?? 0;
      const over = Math.max(0, row.running - (maxAgents === "auto" ? top : maxAgents));
      const paused = Array.from({ length: over }, (_, i) => `T${String(90 + i)}`);
      f.answer("cap_set", { project: { projectRef: clone(projectRef), maxAgents, pauseExtras: true } }, { ...out, paused });
    };
    const others = rows.filter((r) => r !== row);
    for (let n = 1; n <= 16; n++) answer(n, { slots: slotState(fleetCap, machines, [...others, { ...row, maxAgents: n, set: true }]) });
    answer("auto", { slots: slotState(fleetCap, machines, [...others, { ...row, set: false }]) });
  }
  for (const m of machines) {
    const others = machines.filter((o) => o !== m);
    const at = (next: MachineCap) => ({ slots: slotState(fleetCap, [...others, next], rows) });
    for (let n = 1; n <= 64; n++) f.answer("cap_set", { machine: { machineId: m.machineId, maxAgents: n } }, at({ ...m, cap: n, set: true, source: "set" }));
    f.answer("cap_set", { machine: { machineId: m.machineId, maxAgents: "auto" } }, at({ ...m, cap: m.auto, set: false, source: "memory" }));
  }
  for (let n = 1; n <= 64; n++) f.answer("cap_set", { cap: n }, { slots: slotState(n, machines, rows) });
  f.answer("cap_set", { cap: "auto" }, { slots: slotState(undefined, machines, rows) });
  return f;
}

export default defineGroup({
  extend: {
    ...Object.fromEntries(SHARED.map((name) => [name, shared])),
    empty: (f) => {
      basics(f);
      // An empty hub still has every prompt; the recording read none of them.
      const hub = new PromptHub(registry, { edits: false });
      for (const { id } of hub.prompts) {
        const got = hub.answer("prompt_get", { id });
        if (got.ok && f.output("prompt_get", { id }) === undefined) f.answer("prompt_get", { id }, json(got.output));
      }
    },
  },
  fixtures: (base) => {
    const hub = new PromptHub(registry);
    const f = Fixture.from(
      base("typical"),
      "settings-prompts",
      "Every prompt of this fleetd with its real text, edits hub-wide and for acme/storefront, one default changed under an edit",
    );
    f.drop("prompt_get");
    f.drop("project_get");
    basics(f);
    // Hub-wide, and acme/storefront (which has its own edits); the picker's other projects read as hub-wide.
    for (const projectRef of [undefined, { machineId: "devbox", projectId: "storefront" }]) {
      const scope = projectRef ? { projectRef } : {};
      const list = hub.answer("prompt_get", scope);
      if (list.ok) f.answer("prompt_get", projectRef ? scope : undefined, json(list.output));
      for (const { id } of hub.prompts) {
        const got = hub.answer("prompt_get", { id, ...scope });
        if (got.ok) f.answer("prompt_get", { id, ...scope }, json(got.output));
      }
    }
    const withAgents = agents(base("typical"), "settings-agents", "Machines sized by memory, one set above it, one short of disk; no fleet cap");
    // The fleet cap a lab run left saved: shown as set, next to what the machines fit.
    const fleetSet = agents(base("typical"), "settings-agents-fleet", "As settings-agents, with a saved fleet cap of 40", 40);
    // storefront's medium switch off: every one of its tasks runs high.
    const off = Fixture.from(withAgents, "settings-medium-off", "Max agents as in settings-agents, with storefront's medium switch off");
    const storefront = isObject(off.snapshot) && Array.isArray(off.snapshot["projects"]) ? off.snapshot["projects"].filter(isObject)[0] : undefined;
    projectSettings(off, new Set(storefront === undefined ? [] : [asText(storefront["projectId"])]));
    return [f, withAgents, fleetSet, off];
  },
});
