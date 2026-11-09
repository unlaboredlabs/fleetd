// skills_list, skill_get, skill_set, skill_delete, skill_install, skill_update, skill_revert and skill_off.
// Writes are a person's (human keys), each a new version of theirs; a lead
// installs with its own `skill_install`, a lead saves with `skill_save` (`calls`). The repo's skills are read from
// the project's node and never written here.
import type { ProjectRef, Role, SkillOrigin, SkillScope, SkillSummary } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_SKILLS } from "../../shared/node_link.ts";
import type { RepoSkill } from "../../shared/sessions.ts";
import { allows } from "../auth/index.ts";
import type { Hub } from "../api/hub.ts";
import { requireRole } from "../api/grants.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { executors } from "../executor/index.ts";
import { fromExecutor } from "../executor/tools.ts";
import { requireHuman, unknownProject } from "../leads/seams.ts";
import { link } from "../link/index.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs, nowMs } from "../store/time.ts";
import { descriptionOf } from "./frontmatter.ts";
import { type Kept, markShadowed, Skills, summary } from "./index.ts";
import { fetch, find, isLocal, parse, record, sourceOf } from "./install.ts";
import * as versions from "./versions.ts";

/** A person's write, as its version names them: their name, else their key's. */
const person = (hub: Hub, caller: Caller, why?: string) => versions.person(caller.person?.name ?? caller.name, why, nowMs(hub.clock));

function knownProject(hub: Hub, caller: Caller, r: ProjectRef, role: Role): void {
  requireRole(caller, role, r.machineId);
  if (!store(hub).projectGet(r)) throw unknownProject(r);
}

const allowsEverywhere = (caller: Caller, role: Role) => caller.grants.some((g) => g.machines === "*" && allows({ ...caller, grants: [g] }, role));

/**
 * The project a write in `scope` is for, checked; undefined for global. A project's skills take operate on its
 * machine; global ones reach every machine's agents, so they take admin on every machine.
 */
function scopeProject(hub: Hub, caller: Caller, scope: SkillScope, r: ProjectRef | undefined): ProjectRef | undefined {
  if (scope === "project") {
    if (!r) throw new ToolError("invalid", "scope project needs projectRef.");
    knownProject(hub, caller, r, "operate");
    return r;
  }
  if (allowsEverywhere(caller, "admin")) return undefined;
  throw new ToolError(
    "forbidden",
    "Global skills reach every machine's agents, so they take admin on every machine, and this key lacks it.",
    "Use a key with admin on every machine, or keep the skill in one project.",
  );
}

const notFound = (name: string) => new ToolError("not_found", `No skill called ${name} here.`, "skills_list lists them.");

/** `skills.changed`, which tells the app to list the skills again. `project` undefined for the global scope. */
export function changed(hub: Hub, project: ProjectRef | undefined, names: string[], by: string): void {
  const list = names.join(", ");
  events(hub).append({
    at: isoMs(nowMs(hub.clock)),
    type: "skills.changed",
    ...(project ? { machineId: project.machineId, projectId: project.projectId } : {}),
    summary: project ? `skills of ${project.machineId}/${project.projectId} changed: ${list}` : `global skills changed: ${list}`,
    data: { scope: project ? "project" : "global", projectRef: project ?? null, names, by },
  });
}

/** The repo's skills from the project's node, or why there are none to show. */
export async function repoSkills(hub: Hub, r: ProjectRef): Promise<RepoSkill[] | string> {
  if (!executors(hub).isConnected(r.machineId)) return `${r.machineId} is offline, so its repo's skills aren't listed.`;
  if (!link(hub).can(r.machineId, CAP_SKILLS)) return `The node on ${r.machineId} is too old to list its repo's skills; update it.`;
  try {
    const out = await executors(hub).call(r.machineId, "read", { op: "skills_list", projectId: r.projectId }, 15_000);
    return (out as { kind?: string; skills?: RepoSkill[] }).kind === "skills" ? ((out as { skills: RepoSkill[] }).skills ?? []) : [];
  } catch (error) {
    return (error as Error).message;
  }
}

const repoSummary = (s: RepoSkill): SkillSummary => ({ name: s.name, origin: s.origin, description: s.description, path: s.path, files: [] }) as SkillSummary;

const REPO_DIRS: Partial<Record<SkillOrigin, string>> = { repo_agents: ".agents/skills", repo_claude: ".claude/skills" };

/** Who installs a skill: a person from any source, fetched with the hub's git; a lead from a remote source only. */
export type Installer = "person" | "lead";

/** Fetches `given` and keeps its skills (or `want`) in the scope, pinned to the commit fetched. */
export async function installFrom(
  hub: Hub,
  scope: SkillScope,
  r: ProjectRef | undefined,
  given: string,
  want: string | undefined,
  by: Installer,
  who: versions.Who,
): Promise<{ kept: Kept[]; commit: string }> {
  const source = parse(given);
  if (isLocal(source) && by !== "person") {
    throw new ToolError(
      "forbidden",
      "A lead installs from a remote source only.",
      "Give owner/repo or a GitHub URL; a person can install a local one on the project's Settings › Agents.",
    );
  }
  const fetched = await fetch(source);
  try {
    const found = find(fetched.tree, source, want ?? source.skill);
    const at = isoMs(nowMs(hub.clock));
    const kept = Skills.of(hub).putFolders(
      scope,
      r,
      found.map((f) => [f.name, f.files, record(given, source, fetched.commit, f.path, at)]),
      { ...who, why: `Installed from ${given} at ${fetched.commit.slice(0, 12)}` },
    );
    return { kept, commit: fetched.commit };
  } finally {
    fetched.done();
  }
}

export function register(tools: Registry): void {
  tools.add("skills_list", async (hub, caller, input) => {
    const skills = Skills.of(hub);
    const list = skills.list("global").map(summary);
    let repoUnavailable: string | undefined;
    const r = input.projectRef;
    if (r) {
      knownProject(hub, caller, r, "read");
      list.push(...skills.list("project", r).map(summary));
      const repo = await repoSkills(hub, r);
      if (typeof repo === "string") repoUnavailable = repo;
      else list.push(...repo.map(repoSummary));
      const uses = versions.uses(hub.db, r);
      for (const s of list) {
        const u = uses.get(s.name);
        if (!u) continue;
        // Off holds back the hub's skills only: a repo's reaches its sessions from the checkout.
        if (u.off && (s.origin === "project" || s.origin === "global")) s.off = true;
        if (u.lastUsedMs !== undefined) s.lastUsedAt = isoMs(u.lastUsedMs);
      }
    }
    markShadowed(list);
    return {
      skills: list,
      ...(repoUnavailable === undefined ? {} : { repoUnavailable }),
      ...(r ? {} : { next: "skills_list with projectRef adds that project's skills and its repo's." }),
    };
  });

  tools.add("skill_get", async (hub, caller, input) => {
    const r = input.projectRef;
    if (r) knownProject(hub, caller, r, "read");
    const keptIn = (scope: SkillScope, at: ProjectRef | undefined) => {
      const kept = Skills.of(hub).get(scope, at, input.name);
      if (!kept) throw notFound(input.name);
      const history = versions.list(hub.db, scope, at, input.name);
      let text = kept.text;
      if (input.version !== undefined) {
        const v = versions.get(hub.db, scope, at, input.name, input.version);
        if (!v) throw new ToolError("not_found", `${input.name} has no version ${input.version}.`, "skill_get without version lists the ones kept.");
        text = v.text;
      }
      return { skill: summary(kept), text, versions: history };
    };
    if (input.origin === "global") return keptIn("global", undefined);
    if (!r) throw new ToolError("invalid", "Only a global skill is read without projectRef.");
    if (input.origin === "project") return keptIn("project", r);
    const path = `${REPO_DIRS[input.origin] ?? ""}/${input.name}/SKILL.md`;
    let text: string | undefined;
    try {
      const out = await executors(hub).call(r.machineId, "read", { op: "read_file", projectId: r.projectId, path }, 15_000);
      text = (out as { kind?: string; contents?: string }).kind === "file" ? (out as { contents?: string }).contents : undefined;
    } catch (error) {
      throw fromExecutor(error);
    }
    if (text === undefined) throw notFound(input.name);
    return { skill: repoSummary({ name: input.name, origin: input.origin, description: descriptionOf(text), path }), text, versions: [] };
  });

  tools.add("skill_set", (hub, caller, input) => {
    requireHuman(caller, "skill_set");
    const r = scopeProject(hub, caller, input.scope, input.projectRef);
    const kept = Skills.of(hub).set(input.scope, r, input.name, input.text, input.create === true, person(hub, caller, input.why));
    changed(hub, r, [input.name], caller.name);
    return { skill: summary(kept), next: "Saved. Sessions get it from their next start." };
  });

  tools.add("skill_delete", (hub, caller, input) => {
    requireHuman(caller, "skill_delete");
    const r = scopeProject(hub, caller, input.scope, input.projectRef);
    if (!Skills.of(hub).delete(input.scope, r, input.name)) throw notFound(input.name);
    changed(hub, r, [input.name], caller.name);
    return { ok: true };
  });

  tools.add("skill_install", async (hub, caller, input) => {
    requireHuman(caller, "skill_install");
    const r = scopeProject(hub, caller, input.scope, input.projectRef);
    const { kept, commit } = await installFrom(hub, input.scope, r, input.source, input.skill, "person", person(hub, caller));
    changed(
      hub,
      r,
      kept.map((k) => k.name),
      caller.name,
    );
    return {
      installed: kept.map(summary),
      next: `Pinned to ${commit.slice(0, 12)}. Sessions get it from their next start; Update fetches newer commits.`,
    };
  });

  tools.add("skill_update", async (hub, caller, input) => {
    requireHuman(caller, "skill_update");
    const r = scopeProject(hub, caller, input.scope, input.projectRef);
    const skills = Skills.of(hub);
    const kept = skills.get(input.scope, r, input.name);
    if (!kept) throw notFound(input.name);
    const pin = kept.install;
    if (!pin) throw new ToolError("invalid", `${input.name} was written here, not installed: it has no source to update from.`);
    const source = sourceOf(pin);
    const fetched = await fetch(source);
    try {
      if (fetched.commit === pin.commit) {
        const now = skills.get(input.scope, r, input.name);
        if (!now) throw notFound(input.name);
        return { skill: summary(now), updated: false, next: "Already at the newest commit." };
      }
      const found = find(fetched.tree, source, input.name);
      const at = isoMs(nowMs(hub.clock));
      const why = `Updated from ${pin.source} to ${fetched.commit.slice(0, 12)}`;
      const put = skills.putFolders(
        input.scope,
        r,
        found.map((f) => [f.name, f.files, record(pin.source, source, fetched.commit, f.path, at)]),
        person(hub, caller, why),
      );
      changed(hub, r, [input.name], caller.name);
      return { skill: summary(put[0] as Kept), updated: true, next: "Updated. Sessions get it from their next start." };
    } finally {
      fetched.done();
    }
  });

  tools.add("skill_revert", (hub, caller, input) => {
    requireHuman(caller, "skill_revert");
    const r = scopeProject(hub, caller, input.scope, input.projectRef);
    const skills = Skills.of(hub);
    if (!skills.get(input.scope, r, input.name)) throw notFound(input.name);
    const v = versions.get(hub.db, input.scope, r, input.name, input.version);
    if (!v) throw new ToolError("not_found", `${input.name} has no version ${input.version}.`, "skill_get lists the versions kept.");
    const kept = skills.set(input.scope, r, input.name, v.text, false, person(hub, caller, `Back to version ${input.version}`));
    changed(hub, r, [input.name], caller.name);
    return { skill: summary(kept), next: "Reverted, as a new version. Sessions get it from their next start." };
  });

  tools.add("skill_off", (hub, caller, input) => {
    requireHuman(caller, "skill_off");
    knownProject(hub, caller, input.projectRef, "operate");
    const skills = Skills.of(hub);
    const kept = skills.get("project", input.projectRef, input.name) !== undefined || skills.get("global", undefined, input.name) !== undefined;
    if (input.off && !kept) {
      throw new ToolError(
        "not_found",
        `The hub keeps no skill called ${input.name} for this project.`,
        "Only the hub's skills turn off here: one in the repo's or a project's folder reaches its sessions from              there, so remove it from that folder.",
      );
    }
    versions.setOff(hub.db, input.projectRef, input.name, input.off);
    changed(hub, input.projectRef, [input.name], caller.name);
    return {
      ok: true,
      next: input.off ? "Off: the project's sessions don't get it from their next start." : "On: the project's sessions get it from their next start.",
    };
  });
}
