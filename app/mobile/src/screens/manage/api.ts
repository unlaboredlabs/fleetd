// The hub calls behind a project's screens, each as the desktop makes it: New Project (project_discover, then the
// desktop's add flow over project_add, a new folder or a repo, with Only me), its screen's reads (agents_list,
// orders_board, checklist_get, pr_list, profiles_list, skills_list, agent_messages' count), Rename (project_settings_set's title), Only me
// (its onlyMe), Archive, its bot's color (avatarColor) or picture (attachment_put, then project_avatar_set), the
// person's own picture and name (person_avatar_set, person_name_set), Agent
// Profiles (project_set), Approvals, Linked hubs (hub_links_get, hub_link_remove), Forget
// Sign-ins and Delete (project_settings_get for its worktrees, then project_remove with them). A project's own tools go
// by the desktop's names for them (PROJECT_TOOLS); Payments' calls are its own (Payments.tsx).
import { allowedAfter, APPROVED_FIRST_PAGE, APPROVED_PAGE, discovery, PROJECT_TOOLS, type ApprovedPages, type AddCall, type ApprovalMode, type ApprovalsOutput, type AttachmentMime, type AvatarCrop, type HubLink, type AgentRow, type Discovery, type HubError, type OrderCard, type PrRow, type ProfilesListOutput, type ProjectRef, type ProjectSettings, type ProjectSummary, type SkillSummary, type TodoItem } from "../../desktop";
import type { Session } from "../../session";
import { upload, UPLOAD_TIMEOUT_MS } from "../../upload";
import { MERGES_DAYS } from "./model";

export type Hub = Pick<Session, "call">;

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: HubError };

const ref = (p: ProjectRef): ProjectRef => ({ machineId: p.machineId, projectId: p.projectId });

/** Ending its open browser session, then deleting its profile, can take a while (as the desktop's). */
export const FORGET_MS = 60_000;
/** The hub gives the node 70 s to stop a project's processes, end its previews and browser, then remove it. */
export const REMOVE_MS = 80_000;

/**
 * Checkouts on the machines and the person's GitHub repos (`gh repo list` can take a while), machine ids as names;
 * `home` leaves out the machines no project lives on (the agents' Mac: projectHome).
 */
const DISCOVER_MS = 45_000;

export const discover = async (hub: Hub, name: (machineId: string) => string, home?: (machineId: string) => boolean): Promise<Result<Discovery>> => {
  const r = await hub.call("project_discover", {}, DISCOVER_MS);
  return r.ok ? { ok: true, value: discovery(r.output, name, home) } : r;
};

/**
 * One of the add flow's project_add calls, the add itself named as the person typed (a clone's too) and with Only me
 * as they left it, on or off: left out, the hub would pick its own default (on for a folder with no git repo). A dry
 * run only inspects, so it takes neither.
 */
export const addCall = async (hub: Hub, call: AddCall, title: string, onlyMe: boolean): Promise<{ readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: HubError }> => {
  if (call.purpose !== "add") return hub.call("project_add", call.input);
  return hub.call("project_add", { ...call.input, ...(title === "" ? {} : { title }), onlyMe });
};

/** Its settings' title. Its folder keeps its name. */
export const rename = async (hub: Hub, p: ProjectRef, name: string): Promise<Result<null>> => {
  const r = await hub.call("project_settings_set", { ...ref(p), title: name });
  return r.ok ? { ok: true, value: null } : r;
};

/** Its bot's color, from the palette (BOT_COLORS). */
export const setBotColor = async (hub: Hub, p: ProjectRef, avatarColor: string): Promise<Result<null>> => {
  const r = await hub.call("project_settings_set", { ...ref(p), avatarColor });
  return r.ok ? { ok: true, value: null } : r;
};

/** Only me: only its owner sees and uses it, the person turning it on becoming its owner; off, everyone on the hub again. */
export const setOnlyMe = async (hub: Hub, p: ProjectRef, onlyMe: boolean): Promise<Result<null>> => {
  const r = await hub.call("project_settings_set", { ...ref(p), onlyMe });
  return r.ok ? { ok: true, value: null } : r;
};

/** Archived, it keeps its chat, memory and folder, and its lead doesn't start until it is brought back. */
export const setArchived = async (hub: Hub, p: ProjectRef, archived: boolean): Promise<Result<null>> => {
  const r = await hub.call(PROJECT_TOOLS.archive, { ...ref(p), archived });
  return r.ok ? { ok: true, value: null } : r;
};

/** A picture as it was picked and the square of it to keep: sent to the hub, which keeps that square alone. */
export const setPicture = async (hub: Hub, p: ProjectRef, bytes: Uint8Array, mime: AttachmentMime, crop: AvatarCrop): Promise<Result<ProjectSummary>> => {
  const sent = await upload((tool, input, ms) => hub.call(tool, input, ms), bytes, mime === "image/png" ? "picture.png" : "picture.jpg", mime);
  if (!sent.ok) return { ok: false, error: { code: "failed", message: sent.message } };
  const r = await hub.call("project_avatar_set", { ...ref(p), attachmentId: sent.ref.attachmentId, crop }, UPLOAD_TIMEOUT_MS);
  return r.ok ? { ok: true, value: r.output.project } : r;
};

/** The person's own picture, as picked with the square to keep, as a project's (setPicture). */
export const setMyPicture = async (hub: Hub, bytes: Uint8Array, mime: AttachmentMime, crop: AvatarCrop): Promise<Result<null>> => {
  const sent = await upload((tool, input, ms) => hub.call(tool, input, ms), bytes, mime === "image/png" ? "picture.png" : "picture.jpg", mime);
  if (!sent.ok) return { ok: false, error: { code: "failed", message: sent.message } };
  const r = await hub.call("person_avatar_set", { attachmentId: sent.ref.attachmentId, crop }, UPLOAD_TIMEOUT_MS);
  return r.ok ? { ok: true, value: null } : r;
};

/** The person's own picture taken away: their initials show again. */
export const removeMyPicture = async (hub: Hub): Promise<Result<null>> => {
  const r = await hub.call("person_avatar_set", {});
  return r.ok ? { ok: true, value: null } : r;
};

/**
 * The person's own name, as typed: the hub trims it, drops control characters and refuses an empty one, and answers
 * with the name it kept. Its people.changed brings it to every open app, this one's Settings and chats list too.
 */
export const setMyName = async (hub: Hub, name: string): Promise<Result<string>> => {
  const r = await hub.call("person_name_set", { name });
  return r.ok ? { ok: true, value: r.output.person.name } : r;
};

/** Its picture taken away: its bot shows again. */
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
  /** Its skills, for its Skills row's count. */
  readonly skills?: readonly SkillSummary[];
  /** How many DMs its agents sent each other, for its row's count. */
  readonly dms?: number;
  /** The first read that failed, said under the sections; what did come is shown. */
  readonly error?: HubError;
}

/** One read landed over what is shown: its section replaced, the first failure kept. */
export const withPart = (shown: Info, got: Info): Info => ({ ...shown, ...got, ...(shown.error === undefined ? {} : { error: shown.error }) });

/**
 * Its screen's reads, side by side; its skills and its agents' DMs' count only from a hub that keeps them (`has`). Each read is handed to
 * `part` as it lands, so a slow one (pr_list waits on GitHub, seconds on a cold cache) holds up none of the others;
 * the promise answers them all, with the first that failed.
 */
export const readInfo = async (hub: Hub, p: ProjectRef, nowMs: number, has: { readonly skills: boolean; readonly dms: boolean }, part?: (got: Info) => void): Promise<Info> => {
  const projectRef = ref(p);
  const since = new Date(nowMs - MERGES_DAYS * 86_400_000).toISOString();
  let all: Info = {};
  const land = <T,>(read: Promise<T>, piece: (r: T) => Info): Promise<void> =>
    read.then((r) => {
      const got = piece(r);
      all = withPart(all, got);
      part?.(got);
    });
  const failed = (r: { ok: false; error: HubError }): Info => ({ error: r.error });
  await Promise.all([
    land(hub.call("agents_list", { projectRef }), (r) => (r.ok ? { agents: r.output.agents } : failed(r))),
    land(hub.call("checklist_get", { projectRef }), (r) => (r.ok ? { checklist: r.output.items } : failed(r))),
    land(hub.call("orders_board", { projectRef }), (r) => (r.ok ? { orders: r.output.orders } : failed(r))),
    land(hub.call("pr_list", { projectRef, closedSince: since }), (r) => (r.ok ? { prs: r.output.prs } : failed(r))),
    land(hub.call("profiles_list", { projectRef }), (r) => (r.ok ? { profiles: r.output } : failed(r))),
    ...(has.skills ? [land(hub.call("skills_list", { projectRef }), (r) => (r.ok ? { skills: r.output.skills } : failed(r)))] : []),
    ...(has.dms ? [land(hub.call("agent_messages", { projectRef, limit: 1 }), (r) => (r.ok ? { dms: r.output.total } : failed(r)))] : []),
  ]);
  return all;
};

/** Checks or unchecks one profile for its agents; the hub's default stays allowed. Answers the allowed ones now. */
export const setProfile = async (hub: Hub, p: ProjectRef, view: ProfilesListOutput, name: string, on: boolean): Promise<Result<string[]>> => {
  const defaultName = view.profiles.find((x) => x.default)?.name;
  const r = await hub.call("project_set", { ...ref(p), profiles: allowedAfter(view.allowed ?? [], defaultName, name, on) });
  return r.ok ? { ok: true, value: r.output.profiles } : r;
};

export const forgetSignins = async (hub: Hub, p: ProjectRef): Promise<Result<null>> => {
  const r = await hub.call(PROJECT_TOOLS.signinsForget, ref(p), FORGET_MS);
  return r.ok ? { ok: true, value: null } : r;
};

/** How its risky actions are approved, and the log of what ran without asking. */
export const readApprovals = async (hub: Hub, p: ProjectRef): Promise<Result<ApprovalsOutput>> => {
  const read = await hub.call(PROJECT_TOOLS.approvals, { ...ref(p), limit: APPROVED_FIRST_PAGE });
  return read.ok ? { ok: true, value: read.output } : read;
};

/** A mode picked: the checker always runs on the hub's own model. */
export const setApprovalMode = async (hub: Hub, p: ProjectRef, mode: ApprovalMode): Promise<Result<null>> => {
  const r = await hub.call(PROJECT_TOOLS.approvalsSet, { ...ref(p), mode });
  return r.ok ? { ok: true, value: null } : r;
};

/** A page of what ran without asking, newest first: from the newest, or older than `before` (the last page's `older`). */
export const readApprovedPage = async (hub: Hub, p: ProjectRef, before?: number): Promise<Result<ApprovedPages>> => {
  const r = await hub.call(PROJECT_TOOLS.approvals, { ...ref(p), limit: APPROVED_PAGE, ...(before === undefined ? {} : { before }) });
  return r.ok ? { ok: true, value: { log: r.output.log, older: r.output.older } } : r;
};

/** The other hubs it reaches through hub links. */
export const readLinks = async (hub: Hub, p: ProjectRef): Promise<Result<readonly HubLink[]>> => {
  const r = await hub.call("hub_links_get", { navi: ref(p) });
  return r.ok ? { ok: true, value: r.output.links.filter((l) => l.navi.machineId === p.machineId && l.navi.projectId === p.projectId) } : r;
};

/** A link removed here, and revoked on the other hub when it can be reached: the hub says which, and what's next. */
export const removeLink = async (hub: Hub, linkId: string): Promise<Result<{ readonly revokedThere: boolean; readonly next?: string }>> => {
  const r = await hub.call("hub_link_remove", { linkId });
  return r.ok ? { ok: true, value: { revokedThere: r.output.revokedThere, ...(r.output.next === undefined ? {} : { next: r.output.next }) } } : r;
};

/** Its settings fresh from its machine, so the confirm names every worktree with uncommitted changes. */
export const readForDelete = async (hub: Hub, p: ProjectRef): Promise<Result<ProjectSettings>> => {
  const r = await hub.call("project_settings_get", ref(p));
  return r.ok ? { ok: true, value: r.output.settings } : r;
};

/**
 * Stops its agents and erases everything fleetd keeps for it, its fleetd worktrees and its other repos' checkouts
 * with it; with `removeFolder` its folder goes too.
 */
export const deleteProject = async (hub: Hub, p: ProjectRef, removeFolder = false): Promise<Result<null>> => {
  const r = await hub.call("project_remove", { ...ref(p), removeWorktrees: true, ...(removeFolder ? { removeFolder: true } : {}) }, REMOVE_MS);
  return r.ok ? { ok: true, value: null } : r;
};
