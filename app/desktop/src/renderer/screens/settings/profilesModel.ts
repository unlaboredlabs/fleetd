// The model and effort behind each task profile as Settings edits them (profiles_get, profiles_set): fleet-wide in
// Settings → Agents, as a project's override in its settings. An unset field follows the next scope: a project's the
// fleet's, the fleet's the profile's own.
import type { Effort, ProfileRun, ProfileSetting, ProfilesGetOutput, TaskProfile } from "../../../shared/contracts";

export const PROFILES: ReadonlyArray<{ readonly profile: TaskProfile; readonly label: string; readonly help: string }> = [
  { profile: "high", label: "High", help: "The default: the lead, every review, claude's helper calls and every task not marked medium." },
  { profile: "medium", label: "Medium", help: "Mechanical tasks the lead picks." },
];

export type EffortChoice = Effort | "default";

export const EFFORTS: ReadonlyArray<{ readonly value: EffortChoice; readonly label: string }> = [
  { value: "default", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

export type ProfileDraft = { readonly model: string; readonly effort: EffortChoice };

/** A model as the runner's --model takes it, as the hub checks it (ModelName). */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,79}$/u;

export const draftOf = (s: ProfileSetting | undefined): ProfileDraft => ({ model: s?.model ?? "", effort: s?.effort ?? "default" });

/** The setting to send, or why it can't go. An empty model or Default effort leaves that field unset. */
export const settingFrom = (d: ProfileDraft): { ok: true; setting: ProfileSetting } | { ok: false; problem: string } => {
  const model = d.model.trim();
  if (model !== "" && !MODEL.test(model)) {
    return { ok: false, problem: "A model is one word as claude takes it, like claude-sonnet-5-5 or sonnet: letters, digits and . _ : / @ [ ] -, up to 80." };
  }
  return { ok: true, setting: { ...(model === "" ? {} : { model }), ...(d.effort === "default" ? {} : { effort: d.effort }) } };
};

export const changed = (d: ProfileDraft, s: ProfileSetting | undefined) => {
  const saved = draftOf(s);
  return d.model.trim() !== saved.model || d.effort !== saved.effort;
};

export const runLine = (r: ProfileRun) => `${r.model} at ${r.effort} effort`;

/** What an unset field of this scope's setting follows: for a project, the fleet's (when it sets one) or the own. */
export const follows = (view: ProfilesGetOutput, profile: TaskProfile, project: boolean): { model: string; effort: Effort } => {
  const own = view.defaults[profile];
  const fleet = project ? view.fleet[profile] : undefined;
  const fleetModel = fleet?.refused === undefined ? fleet?.model : undefined;
  return { model: fleetModel ?? own.model, effort: fleet?.effort ?? own.effort };
};
