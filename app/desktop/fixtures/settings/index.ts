// Settings' fixture data. The shared fixtures get what Settings asks beyond the recorded traffic (the projects for
// the pickers, the dry run, a prompt whose default changed), and `settings-prompts` is the whole real
// registry from the fake prompt hub: every prompt's real text, a hub-wide edit made against an older default (the
// 3-way Update view), a project's own edit, and the instructions at both levels.
import fs from "node:fs";
import { defineGroup, SHARED } from "../kit/group.ts";
import { Fixture } from "../kit/fixture.ts";
import { asText, clone, isObject, type JsonObject, type JsonValue } from "../kit/json.ts";
import { PROJECTS, PromptHub, type RegistryEntry } from "./promptHub.ts";
import { skills } from "./skills.ts";

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

/** The fleet runs medium on Sonnet at medium effort; high is left to the profile's own. */
const PROFILES_VIEW: JsonObject = {
  fleet: { high: {}, medium: { model: "claude-sonnet-5-5" } },
  runs: { high: { model: "claude-opus-5-5", effort: "high" }, medium: { model: "claude-sonnet-5-5", effort: "medium" } },
  defaults: { high: { model: "claude-opus-5-5", effort: "high" }, medium: { model: "claude-opus-5-5", effort: "medium" } },
};

/**
 * Each project's "medium allowed" switch as project_get reads it (on, unless named in `off`), and project_set's
 * answer either way; the task profiles' settings, the fleet's and each project's (none).
 */
function projectSettings(f: Fixture, off: ReadonlySet<string> = new Set()) {
  const projects = isObject(f.snapshot) && Array.isArray(f.snapshot["projects"]) ? f.snapshot["projects"].filter(isObject) : [];
  for (const p of projects) {
    const ref = { machineId: asText(p["machineId"]), projectId: asText(p["projectId"]) };
    f.answer("project_get", ref, { asOf: f.now, project: clone(p), stale: false, threads: [], mediumAllowed: !off.has(ref.projectId) });
    for (const on of [true, false]) f.answer("project_set", { ...ref, mediumAllowed: on }, { mediumAllowed: on });
    f.answer("profiles_get", { projectRef: ref }, { ...PROFILES_VIEW, project: { high: {}, medium: {} } });
  }
  f.answer("profiles_get", {}, PROFILES_VIEW);
}


/**
 * Settings → Memory: user.md with entries the lead remembered (each linked to its chat line), and the first project's
 * MEMORY.md with its always-on part and a topic. Other projects remember nothing yet.
 */
function memory(f: Fixture) {
  const projects = isObject(f.snapshot) && Array.isArray(f.snapshot["projects"]) ? f.snapshot["projects"].filter(isObject) : [];
  const ref = (p: JsonObject): JsonObject => ({ machineId: asText(p["machineId"]), projectId: asText(p["projectId"]) });
  const first = projects[0];
  const at = "2026-10-19T10:21:00.000Z";
  const file = (scope: string, text: string, cap: number, notes: JsonObject[] = [], topic?: string): JsonObject => ({
    scope,
    ...(topic ? { topic } : {}),
    text,
    chars: Array.from(text).length,
    cap,
    ...(text ? { updatedAt: at } : {}),
    notes,
  });
  const note = (text: string, n: number): JsonObject[] => (first ? [{ text, at, projectRef: ref(first), messageId: `m${String(n)}` }] : []);
  const user = file(
    "user",
    "- Concise. State first, then what you need from me.\n- No AI slop: plain words, no filler, no hype.\n- Never estimate time.\n",
    4000,
    [...note("No AI slop: plain words, no filler, no hype.", 41), ...note("Concise. State first, then what you need from me.", 12)],
  );
  f.answer("memory_get", undefined, { user });
  for (const p of projects) {
    const own = p === first;
    const index = own ? "- Public repo: nothing private in PRs or docs.\n- No npm here: use pnpm.\n- [deploys](deploys.md)\n" : "";
    const files = [file("project", index, 4000, own ? note("No npm here: use pnpm.", 33) : [])];
    if (own) files.push(file("project", "- Staging first, always.\n- Releases go out Tuesdays.\n", 8000, [], "deploys"));
    const chars = files.reduce((sum, x) => sum + (typeof x["chars"] === "number" ? x["chars"] : 0), 0);
    f.answer("memory_get", { projectRef: ref(p) }, { user, files, projectChars: chars, projectCap: 32000 });
  }
  f.answer("memory_set", undefined, { file: user });
  f.answer("memory_undo", undefined, { ok: true });
}

/**
 * Settings → Automations: the first project has a weekday schedule whose last run is done, a webhook whose run is
 * still open (so its next trigger was skipped), and a paused monthly one. Other projects have none yet.
 */
function automations(f: Fixture) {
  const projects = isObject(f.snapshot) && Array.isArray(f.snapshot["projects"]) ? f.snapshot["projects"].filter(isObject) : [];
  const first = projects[0];
  for (const p of projects) {
    f.answer("automation_list", { projectRef: { machineId: asText(p["machineId"]), projectId: asText(p["projectId"]) } }, { automations: [] });
  }
  if (!first) return;
  const projectRef = { machineId: asText(first["machineId"]), projectId: asText(first["projectId"]) };
  const made = "2026-10-12T08:00:00.000Z";
  const run = (automationId: string, n: number, extra: JsonObject): JsonObject => ({ runId: `ar_fixture${String(n)}x`, automationId, ...extra });
  const deps = "au_fixtureDeps1";
  const alerts = "au_fixtureHook1";
  const notes = "au_fixtureNote1";
  const depsRuns = [
    run(deps, 4, { trigger: "schedule", at: "2026-10-19T07:00:00.000Z", state: "done", workstreamId: "W41", scheduledAt: "2026-10-19T07:00:00.000Z", endedAt: "2026-10-19T08:12:00.000Z" }),
    run(deps, 3, { trigger: "manual", at: "2026-10-16T13:20:00.000Z", state: "done", workstreamId: "W36", by: "human", endedAt: "2026-10-16T14:02:00.000Z" }),
    run(deps, 2, { trigger: "schedule", at: "2026-10-16T07:41:00.000Z", state: "stopped", workstreamId: "W35", scheduledAt: "2026-10-16T07:00:00.000Z", lateMin: 41, endedAt: "2026-10-16T09:00:00.000Z" }),
  ];
  const alertRuns = [
    run(alerts, 7, { trigger: "webhook", at: "2026-10-19T10:04:00.000Z", state: "skipped", payloadBytes: 1210, why: "run ar_fixture6x is still going (W57 is open)", endedAt: "2026-10-19T10:04:00.000Z" }),
    run(alerts, 6, { trigger: "webhook", at: "2026-10-19T09:52:00.000Z", state: "running", workstreamId: "W57", payloadBytes: 1184 }),
  ];
  const base = { projectRef, createdBy: "human", createdAt: made, updatedAt: made };
  const list = [
    {
      ...base,
      automationId: deps,
      name: "Weekday dependency check",
      prompt: "Check the dependencies for updates. Open one PR with the patch and minor bumps whose tests pass; list the major ones in the chat.",
      schedule: { cron: "0 9 * * 1-5", tz: "Europe/Berlin" },
      webhook: false,
      paused: false,
      nextRunAt: "2026-10-20T07:00:00.000Z",
      lastRun: depsRuns[0] ?? null,
    },
    {
      ...base,
      automationId: alerts,
      name: "Error alert triage",
      prompt: "An error alert came in. Find the cause from the alert's body and the logs it points to, and fix it if the fix is small.",
      webhook: true,
      paused: false,
      lastRun: alertRuns[0] ?? null,
    },
    {
      ...base,
      automationId: notes,
      name: "Monthly release notes",
      prompt: "Draft the release notes for last month's merged PRs as a PR against docs/releases.",
      schedule: { cron: "0 8 1 * *", tz: "Europe/Berlin" },
      webhook: false,
      paused: true,
    },
  ];
  // The nightly memory refresh, listed with them as a built-in row: last night it tidied the memory.
  const memoryRefresh = {
    on: true,
    at: "04:00",
    tz: "Europe/Berlin",
    nextRunAt: "2026-10-20T02:00:00.000Z",
    lastRun: { at: "2026-10-19T02:00:00.000Z", trigger: "schedule", state: "done", added: 2, replaced: 1, removed: 1 },
  };
  f.answer("automation_list", { projectRef }, { automations: json(list), memoryRefresh });
  f.answer("automation_runs", { automationId: deps }, { runs: depsRuns });
  f.answer("automation_runs", { automationId: alerts }, { runs: alertRuns });
  f.answer("automation_runs", { automationId: notes }, { runs: [] });
  f.answer("automation_run", undefined, { run: run(deps, 8, { trigger: "manual", at: f.now, state: "running", workstreamId: "W62", by: "human" }) });
  f.answer("automation_pause", undefined, { automation: json(list[2]) });
  f.answer("memory_refresh_run", undefined, { memoryRefresh, why: "A refresh is already running." });
}

/**
 * Settings → Machines: the fleet's first machine runs agents and hosts sessions on Linux (Chrome and Xvfb; an Android
 * SDK without KVM), the next only hosts sessions on macOS (iOS simulators), and any after them only run agents. A role
 * change answers with the row it asked for.
 */
function machineRoles(f: Fixture) {
  const machines = isObject(f.snapshot) && Array.isArray(f.snapshot["machines"]) ? f.snapshot["machines"].filter(isObject) : [];
  const linux: JsonObject[] = [
    { host: "browser", ready: true, detail: "Chrome at /home/dev/.fleetd/node/browser/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell" },
    { host: "android", ready: false, detail: "Android SDK at /home/dev/Android/Sdk, but no /dev/kvm: the emulator needs KVM" },
    { host: "ios", ready: false, detail: "iOS simulators need macOS" },
    { host: "desktop", ready: true, detail: "Xvfb at /usr/bin/Xvfb, docker at /usr/bin/docker" },
  ];
  const mac: JsonObject[] = [
    { host: "browser", ready: true, detail: "Chrome not installed yet: the node installs it with the first screen" },
    { host: "android", ready: true, detail: "Android SDK at /Users/dev/Library/Android/sdk" },
    { host: "ios", ready: true, detail: "Xcode with 6 iOS simulators" },
    { host: "desktop", ready: false, detail: "desktop screens run on Linux (docker or Xvfb)" },
  ];
  const entries: JsonObject[] = machines.map((m, i) => {
    const machineId = asText(m["machineId"]);
    const base: JsonObject = { machineId, name: asText(m["name"]) || machineId, online: m["status"] !== "offline", hostsOthers: true };
    if (i === 0) return { ...base, roles: ["agents", "sessions"], maxSessions: 8, maxSessionsWhy: "auto: 16 CPUs, 60 GB", sessionsLive: 2, hosts: linux };
    if (i === 1) return { ...base, roles: ["sessions"], maxSessions: 2, maxSessionsSet: 2, maxSessionsWhy: "set", sessionsLive: 1, hosts: mac };
    return { ...base, roles: ["agents"], maxSessions: 4, maxSessionsWhy: "auto: 8 CPUs, 32 GB", sessionsLive: 0, hosts: linux };
  });
  f.answer("machine_roles", undefined, { machines: entries });
  for (const e of entries) {
    for (const roles of [["agents"], ["sessions"], ["agents", "sessions"]]) {
      f.answer("machine_roles_set", { machineId: asText(e["machineId"]), roles }, { machine: { ...clone(e), roles } });
    }
  }
}

/** What Settings calls besides the prompt reads. */
function basics(f: Fixture) {
  projectSettings(f);
  machineRoles(f);
  memory(f);
  automations(f);
  skills(f);
  if (f.output("project_get") === undefined) f.answer("project_get", undefined, { projects: PROJECTS.map(projectSummary) });
  // The dry run, for any text: a fixture cannot know what will be typed, so it answers with no warnings.
  f.answer("prompt_set", { dryRun: true }, { ref: "lead.start@5e771ed000", warnings: [] });
  // A project's Agents page lists its MCP servers: none, where the recording has no answer of its own.
  f.answer("mcp_servers_get", undefined, { global: [], project: [], userServers: true });
}

/** Every shared fixture: what Settings calls besides the recorded prompt reads. */
const shared = (f: Fixture) => basics(f);

/**
 * Max agents: a fleet cap of 16 with each project at a different point. The first runs 6 under its own max of 12, the
 * second sits at its own max of 3, and the third follows the default. The slot state is set in the snapshot and in
 * every live frame that carries one, since the live state wins.
 */
function agents(from: Fixture): Fixture {
  const f = Fixture.from(from, "settings-agents", "A fleet cap of 16; one project under its max, one at it, one with no limit of its own");
  f.agentsFromSlots = true;
  // An admin's key on a hub from before people: Administration shows, with the fleet and machine caps.
  f.answer("hub_info", undefined, { version: "0.9.0", protocol: 1, busy: [], admin: true });
  const projects = isObject(f.snapshot) && Array.isArray(f.snapshot["projects"]) ? f.snapshot["projects"].filter(isObject) : [];
  const ref = (p: JsonObject): JsonObject => ({ machineId: asText(p["machineId"]), projectId: asText(p["projectId"]) });
  const rows: JsonObject[] = [];
  const [first, second] = projects;
  if (first) rows.push({ projectRef: ref(first), maxAgents: 12, own: true, running: 6, queued: 0 });
  if (second) rows.push({ projectRef: ref(second), maxAgents: 3, own: true, running: 3, queued: 2 });
  // Each machine fits 16 on its own measure, so the fleet cap is what binds.
  const machineIds = [...new Set(projects.map((p) => asText(p["machineId"])))];
  const perMachine = machineIds.map((machineId) => ({ machineId, cap: 16, auto: 16, running: 0, why: "memory 44 GB, about 2 GB an agent" }));
  const slots: JsonObject = { cap: 16, fleetCap: 16, used: 9, queued: 2, perMachine, perProject: rows };
  if (f.snapshot) f.snapshot["slots"] = clone(slots);
  for (const frame of f.live) if (frame["slots"] !== undefined) frame["slots"] = clone(slots);
  // A change answers with the slot state it asked for, as the hub does: every max each project can take (and the
  // pause of the agents over it, which Undo's neighbour offers), back to the default, and every fleet cap the slider
  // reaches.
  for (const p of projects) {
    const projectRef = ref(p);
    const row = rows.find((r) => r["projectRef"] && asText((r["projectRef"] as JsonObject)["projectId"]) === projectRef["projectId"]);
    const running = typeof row?.["running"] === "number" ? row["running"] : 0;
    const queued = row?.["queued"] ?? 0;
    const others = rows.filter((r) => r !== row).map(clone);
    // Back to the default, 16: a busy project still has a row, now not its own.
    const back = running > 0 || queued !== 0 ? [{ projectRef: clone(projectRef), maxAgents: 16, own: false, running, queued }] : [];
    f.answer("cap_set", { project: { projectRef: clone(projectRef), followDefault: true } }, { slots: { ...clone(slots), perProject: [...others, ...back] } });
    for (let n = 1; n <= 16; n++) {
      const own = { projectRef: clone(projectRef), maxAgents: n, own: true, running, queued };
      const perProject = [...others, own];
      const out = { slots: { ...clone(slots), perProject } };
      f.answer("cap_set", { project: { projectRef: clone(projectRef), maxAgents: n } }, out);
      const over = Math.max(0, running - n);
      const paused = Array.from({ length: over }, (_, i) => `T${String(90 + i)}`);
      f.answer("cap_set", { project: { projectRef: clone(projectRef), maxAgents: n, pauseExtras: true } }, { ...out, paused });
    }
  }
  for (let n = 1; n <= 64; n++) f.answer("cap_set", { cap: n }, { slots: { ...clone(slots), cap: n, fleetCap: n } });
  // Administration's hub settings read the global MCP servers too: none.
  f.answer("mcp_servers_get", undefined, { global: [], project: [], userServers: true });
  return f;
}

/**
 * A machine past its memory estimate: devbox fits 22 on its 60 GB (45 after the reserve, at 2 GB an agent) under a fleet
 * cap of 50, storefront is set to 30 there and runs 22 with 8 queued, and a second machine is set to 40. A machine
 * change answers with the slot state it asked for, every number the slider reaches and back to auto.
 */
function machines(from: Fixture): Fixture {
  const f = Fixture.from(from, "settings-machines", "devbox at its auto 22 under a fleet cap of 50, storefront set to 30 there; a second machine set to 40");
  f.agentsFromSlots = true;
  f.answer("hub_info", undefined, { version: "0.9.0", protocol: 1, busy: [], admin: true });
  const projects = isObject(f.snapshot) && Array.isArray(f.snapshot["projects"]) ? f.snapshot["projects"].filter(isObject) : [];
  const [first] = projects;
  const home = first === undefined ? "devbox" : asText(first["machineId"]);
  const other = projects.map((p) => asText(p["machineId"])).find((m) => m !== home);
  const devbox: JsonObject = { machineId: home, cap: 22, auto: 22, running: 22, why: "memory 60 GB, about 2 GB an agent" };
  const perMachine: JsonObject[] = [devbox];
  if (other !== undefined) perMachine.push({ machineId: other, cap: 40, maxAgents: 40, auto: 28, running: 0, why: "28 of 32 CPUs" });
  const rows: JsonObject[] = [];
  if (first) rows.push({ projectRef: { machineId: home, projectId: asText(first["projectId"]) }, maxAgents: 30, own: true, running: 22, queued: 8 });
  const slots: JsonObject = { cap: 50, fleetCap: 50, used: 22, queued: 8, perMachine, perProject: rows };
  if (f.snapshot) f.snapshot["slots"] = clone(slots);
  for (const frame of f.live) if (frame["slots"] !== undefined) frame["slots"] = clone(slots);
  for (const m of perMachine) {
    const machineId = asText(m["machineId"]);
    const at = (row: JsonObject) => ({ slots: { ...clone(slots), perMachine: perMachine.map((x) => (x === m ? row : clone(x))) } });
    const auto = typeof m["auto"] === "number" ? m["auto"] : 1;
    const { maxAgents: _set, ...unset } = clone(m);
    f.answer("cap_set", { machine: { machineId, auto: true } }, at({ ...unset, cap: auto }));
    for (let n = 1; n <= 50; n++) f.answer("cap_set", { machine: { machineId, maxAgents: n } }, at({ ...clone(m), cap: n, maxAgents: n }));
  }
  f.answer("mcp_servers_get", undefined, { global: [], project: [], userServers: true });
  return f;
}

/**
 * Settings → Projects → Repos: storefront holds two repos. Its own runs with the project's setup and preview; billing,
 * checked out on another machine, has a setup and a preview of its own.
 */
function repos(from: Fixture): Fixture {
  const f = Fixture.from(from, "settings-repos", "storefront holds two repos: its own on the project's setup, and billing with its own setup and preview");
  const projects = isObject(f.snapshot) && Array.isArray(f.snapshot["projects"]) ? f.snapshot["projects"].filter(isObject) : [];
  const [storefront, billing] = projects;
  if (storefront === undefined || billing === undefined) return f;
  const ref = (p: JsonObject): JsonObject => ({ machineId: asText(p["machineId"]), projectId: asText(p["projectId"]) });
  storefront["repos"] = [
    { repoId: "R1", name: "storefront", checkout: ref(storefront), repoKey: "github.com/acme/storefront", base: "main" },
    { repoId: "R2", name: "billing", checkout: ref(billing), repoKey: "github.com/acme/billing", base: "main" },
  ];
  const settings: JsonObject = {
    ...ref(storefront),
    title: asText(storefront["title"]),
    workspaceRoot: asText(storefront["workspaceRoot"]),
    keepWorktrees: false,
    env: [],
    setup: { commands: ["pnpm install --frozen-lockfile"], timeoutSec: 600, runAnyway: false, inputs: ["pnpm-lock.yaml"] },
    preview: { web: { start: "pnpm dev --port $PORT", ready: "/" } },
    worktrees: { dir: `/home/dev/.fleetd/node/worktrees/${asText(storefront["projectId"])}`, baseBranch: "main", worktrees: [] },
  };
  // Main matches an answer's input as a subset, so the repo's own answer goes first; storefront's repo gets the project's.
  f.answer(
    "project_settings_get",
    { ...ref(storefront), repo: "billing" },
    {
      settings: {
        ...settings,
        repo: "billing",
        setup: { commands: ["pnpm install --frozen-lockfile", "pnpm db:migrate"], timeoutSec: 600, runAnyway: false, inputs: [] },
        preview: { web: { start: "pnpm --filter billing dev --port $PORT", ready: "/health" } },
      },
    },
  );
  f.answer("project_settings_get", ref(storefront), { settings });
  f.answer("mcp_servers_get", undefined, { global: [], project: [], userServers: true });
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
    const withAgents = agents(base("typical"));
    // storefront's medium switch off: every one of its tasks runs high.
    const off = Fixture.from(withAgents, "settings-medium-off", "Max agents as in settings-agents, with storefront's medium switch off");
    const storefront = isObject(off.snapshot) && Array.isArray(off.snapshot["projects"]) ? off.snapshot["projects"].filter(isObject)[0] : undefined;
    projectSettings(off, new Set(storefront === undefined ? [] : [asText(storefront["projectId"])]));
    return [f, withAgents, off, machines(base("typical")), repos(base("typical"))];
  },
});
