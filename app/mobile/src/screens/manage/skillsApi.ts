// The hub calls behind a Navi's Skills screens, each as the desktop makes it: the list (skills_list), a skill and its
// versions (skill_get, an older version's text by `version`), the person's edit (skill_set), a restore (skill_revert),
// Turn Off (skill_off) and Delete (skill_delete). Every write fires skills.changed, which the screens read again on.
import type { HubError, HubEvent, ProjectRef, SkillOrigin } from "../../desktop";
import type { Hub, Result } from "./api";
import type { Skill, SkillRead } from "./skillsModel";

// skill_revert and skill_off, and skill_get's `version`, aren't in the generated contracts yet (D261): called untyped.
type Untyped = (tool: string, input: unknown, timeoutMs?: number) => Promise<{ readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: HubError }>;
const untyped = (hub: Hub): Untyped => hub.call.bind(hub) as unknown as Untyped;

const ref = (p: ProjectRef): ProjectRef => ({ machineId: p.machineId, projectId: p.projectId });

export const listSkills = async (hub: Hub, p: ProjectRef): Promise<Result<readonly Skill[]>> => {
  const r = await hub.call("skills_list", { projectRef: ref(p) });
  return r.ok ? { ok: true, value: r.output.skills as readonly Skill[] } : r;
};

/** A skill, its versions and the current text; with `version`, that version's text instead. */
export const readSkill = async (hub: Hub, p: ProjectRef, origin: SkillOrigin, name: string, version?: number): Promise<Result<SkillRead>> => {
  const r = await untyped(hub)("skill_get", { origin, projectRef: ref(p), name, ...(version === undefined ? {} : { version }) });
  if (!r.ok) return r;
  const out = r.output as Partial<SkillRead> & Pick<SkillRead, "skill" | "text">;
  return { ok: true, value: { skill: out.skill, text: out.text, versions: out.versions ?? [] } };
};

/** The person's edit of one of the Navi's own skills, a new version with their line on why when they gave one. */
export const saveSkill = async (hub: Hub, p: ProjectRef, name: string, text: string, why: string): Promise<Result<Skill>> => {
  const line = why.trim();
  const r = await untyped(hub)("skill_set", { scope: "project", projectRef: ref(p), name, text, ...(line === "" ? {} : { why: line }) });
  return r.ok ? { ok: true, value: (r.output as { skill: Skill }).skill } : r;
};

/** An older version's text back, as a new version. */
export const restoreSkill = async (hub: Hub, p: ProjectRef, name: string, version: number): Promise<Result<Skill>> => {
  const r = await untyped(hub)("skill_revert", { scope: "project", projectRef: ref(p), name, version });
  return r.ok ? { ok: true, value: (r.output as { skill: Skill }).skill } : r;
};

/** Off: the Navi's sessions don't get it from their next start; it stays, with its history. */
export const turnSkillOff = async (hub: Hub, p: ProjectRef, name: string, off: boolean): Promise<Result<null>> => {
  const r = await untyped(hub)("skill_off", { projectRef: ref(p), name, off });
  return r.ok ? { ok: true, value: null } : r;
};

export const deleteSkill = async (hub: Hub, p: ProjectRef, name: string): Promise<Result<null>> => {
  const r = await hub.call("skill_delete", { scope: "project", projectRef: ref(p), name });
  return r.ok ? { ok: true, value: null } : r;
};

/** A skills.changed that may change what the Navi's screens show: its own scope's, or a hub-wide one's. */
export const touchesSkills = (event: HubEvent, p: ProjectRef): boolean => {
  if (event.type !== "skills.changed") return false;
  const data = event.data as { scope?: string; projectRef?: ProjectRef } | undefined;
  if (data?.scope === "global") return true;
  return data?.projectRef === undefined || (data.projectRef.machineId === p.machineId && data.projectRef.projectId === p.projectId);
};
