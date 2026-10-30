// The hub calls behind a project's and a Navi's screens, each as the desktop makes it: New Navi (machine_roles,
// navi_create), New Project (project_discover, then the desktop's add flow over project_add), its screen's reads
// (agents_list, orders_board, checklist_get, pr_list, profiles_list), Rename (navi_rename, or project_settings_set's
// title), its picture (attachment_put, then project_avatar_set), Agent Profiles (project_set), Forget Sign-ins
// (navi_signins_forget) and Delete (project_settings_get for its worktrees, then project_remove with them).
import { allowedAfter, discovery, isNavi, type AddCall, type AttachmentMime, type AvatarCrop, type AgentRow, type Discovery, type HubError, type MachineRolesEntry, type OrderCard, type PrRow, type ProfilesListOutput, type ProjectRef, type ProjectSettings, type ProjectSummary, type TodoItem } from "../../desktop";
import type { Session } from "../../session";
import { upload, UPLOAD_TIMEOUT_MS } from "../../upload";
import { MERGES_DAYS } from "./model";

export type Hub = Pick<Session, "call">;

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: HubError };

const ref = (p: ProjectRef): ProjectRef => ({ machineId: p.machineId, projectId: p.projectId });

/** Ending a Navi's open browser session, then deleting its profile, can take a while (as the desktop's). */
export const FORGET_MS = 60_000;
/** The hub gives the node 70 s to stop a project's processes, end its previews and browser, then remove it. */
export const REMOVE_MS = 80_000;

/** Where a new Navi may live, and the hub's pick; an older hub without machine_roles leaves the pick to it. */
export const naviHomes = async (hub: Hub): Promise<{ machines: MachineRolesEntry[]; best?: string }> => {
  const r = await hub.call("machine_roles", {});
  if (!r.ok) return { machines: [] };
  return { machines: r.output.machines, ...(r.output.best === undefined ? {} : { best: r.output.best }) };
};

/** Checkouts on the machines and the person's GitHub repos (`gh repo list` can take a while), machine ids as names. */
export const DISCOVER_MS = 45_000;

export const discover = async (hub: Hub, name: (machineId: string) => string): Promise<Result<Discovery>> => {
  const r = await hub.call("project_discover", {}, DISCOVER_MS);
  return r.ok ? { ok: true, value: discovery(r.output, name) } : r;
};

/** One of the add flow's project_add calls, the add itself named as the person typed (a clone's too). */
export const addCall = async (hub: Hub, call: AddCall, title: string): Promise<{ readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: HubError }> => {
  const named = call.purpose === "add" && title !== "" ? { ...call.input, title } : call.input;
  return hub.call("project_add", named);
};

export const createNavi = async (hub: Hub, name: string, machineId: string | undefined): Promise<Result<ProjectSummary>> => {
  const r = await hub.call("navi_create", { name, ...(machineId === undefined ? {} : { machineId }) });
  return r.ok ? { ok: true, value: r.output.navi } : r;
};

/** A Navi by navi_rename; a project by its settings' title. Its folder keeps its name either way. */
export const rename = async (hub: Hub, p: ProjectSummary, name: string): Promise<Result<null>> => {
  const r = isNavi(p) ? await hub.call("navi_rename", { ...ref(p), name }) : await hub.call("project_settings_set", { ...ref(p), title: name });
  return r.ok ? { ok: true, value: null } : r;
};

/** A picture as it was picked and the square of it to keep: sent to the hub, which keeps that square alone. */
export const setPicture = async (hub: Hub, p: ProjectRef, bytes: Uint8Array, mime: AttachmentMime, crop: AvatarCrop): Promise<Result<ProjectSummary>> => {
  const sent = await upload((tool, input, ms) => hub.call(tool, input, ms), bytes, mime === "image/png" ? "picture.png" : "picture.jpg", mime);
  if (!sent.ok) return { ok: false, error: { code: "failed", message: sent.message } };
  const r = await hub.call("project_avatar_set", { ...ref(p), attachmentId: sent.ref.attachmentId, crop }, UPLOAD_TIMEOUT_MS);
  return r.ok ? { ok: true, value: r.output.project } : r;
};

/** Its picture taken away: its letters show again. */
export const removePicture = async (hub: Hub, p: ProjectRef): Promise<Result<ProjectSummary>> => {
  const r = await hub.call("project_avatar_set", ref(p));
  return r.ok ? { ok: true, value: r.output.project } : r;
};

export interface Info {
  readonly agents?: readonly AgentRow[];
  readonly orders?: readonly OrderCard[];
  readonly checklist?: readonly TodoItem[];
  readonly prs?: readonly PrRow[];
  readonly profiles?: ProfilesListOutput;
  /** The first read that failed, said under the sections; what did come is shown. */
  readonly error?: HubError;
}

/** Its screen's reads, side by side: a Navi has no orders, merges or profiles of its own. */
export const readInfo = async (hub: Hub, p: ProjectSummary, nowMs: number): Promise<Info> => {
  const projectRef = ref(p);
  const navi = isNavi(p);
  const since = new Date(nowMs - MERGES_DAYS * 86_400_000).toISOString();
  const [agents, checklist, orders, prs, profiles] = await Promise.all([
    hub.call("agents_list", { projectRef }),
    hub.call("checklist_get", { projectRef }),
    navi ? null : hub.call("orders_board", { projectRef }),
    navi ? null : hub.call("pr_list", { projectRef, closedSince: since }),
    navi ? null : hub.call("profiles_list", { projectRef }),
  ]);
  const error = [agents, checklist, orders, prs, profiles].find((r) => r !== null && !r.ok);
  return {
    ...(agents.ok ? { agents: agents.output.agents } : {}),
    ...(checklist.ok ? { checklist: checklist.output.items } : {}),
    ...(orders?.ok === true ? { orders: orders.output.orders } : {}),
    ...(prs?.ok === true ? { prs: prs.output.prs } : {}),
    ...(profiles?.ok === true ? { profiles: profiles.output } : {}),
    ...(error === undefined || error === null || error.ok ? {} : { error: error.error }),
  };
};

/** Checks or unchecks one profile for its agents; the hub's default stays allowed. Answers the allowed ones now. */
export const setProfile = async (hub: Hub, p: ProjectRef, view: ProfilesListOutput, name: string, on: boolean): Promise<Result<string[]>> => {
  const defaultName = view.profiles.find((x) => x.default)?.name;
  const r = await hub.call("project_set", { ...ref(p), profiles: allowedAfter(view.allowed ?? [], defaultName, name, on) });
  return r.ok ? { ok: true, value: r.output.profiles } : r;
};

export const forgetSignins = async (hub: Hub, p: ProjectRef): Promise<Result<null>> => {
  const r = await hub.call("navi_signins_forget", ref(p), FORGET_MS);
  return r.ok ? { ok: true, value: null } : r;
};

/** Its settings fresh from its machine, so the confirm names every worktree with uncommitted changes. */
export const readForDelete = async (hub: Hub, p: ProjectRef): Promise<Result<ProjectSettings>> => {
  const r = await hub.call("project_settings_get", ref(p));
  return r.ok ? { ok: true, value: r.output.settings } : r;
};

/** Stops its agents and forgets it with its fleetd worktrees and its other repos' checkouts; files and branches stay. */
export const deleteProject = async (hub: Hub, p: ProjectRef): Promise<Result<null>> => {
  const r = await hub.call("project_remove", { ...ref(p), removeWorktrees: true }, REMOVE_MS);
  return r.ok ? { ok: true, value: null } : r;
};
