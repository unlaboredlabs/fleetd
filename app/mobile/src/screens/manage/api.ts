// The hub calls behind a bot's screens, each as the desktop makes it: New Bot (project_discover, then the desktop's
// create flow: project_add for the bot, project_repo_add for each of its repos), its screen's reads (agents_list, orders_board,
// checklist_get, pr_list, profiles_list, skills_list, agent_messages' count), Rename (project_settings_set's title),
// Who merges and its risk rules (project_settings_get, project_settings_set), Archive, its bot's shape and color (avatarShape, avatarColor) or picture (attachment_put, then project_avatar_set), the person's own picture
// and name (person_avatar_set, person_name_set), Agent Profiles (project_set), Approvals, its Computer (project_settings_get for each repo's setup and image, project_image_rebuild), Forget
// Sign-ins and Delete (project_settings_get for its worktrees, then project_remove with them).
// A project's own tools go by the desktop's names for them (PROJECT_TOOLS); Payments' calls are its own (Payments.tsx).
import { allowedAfter, APPROVED_FIRST_PAGE, profileNameFor, APPROVED_PAGE, discovery, PROJECT_TOOLS, type ApprovedPages, type CreateCall, type ApprovalMode, type ApprovalsOutput, type AttachmentMime, type ComputerImage, type ComputerPick, type AvatarCrop, type AgentRow, type Discovery, type HubError, type Merger, type MergeMode, type OrderCard, type PrRow, type ProfilesListOutput, type ProjectRef, type ProjectSettings, type ProjectSummary, type RiskRules, type SkillSummary, type UpToDateRule, type TodoItem } from "../../desktop";
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

/** project_add and project_repo_add may each run gh on the hub. */
const CREATE_MS = 120_000;

/** One of New Bot's calls (the desktop's create.ts): the bot itself, or one of its repos. */
export const createCall = async (hub: Hub, call: CreateCall): Promise<{ readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: HubError }> =>
  call.kind === "create" ? hub.call("project_add", call.input, CREATE_MS) : hub.call("project_repo_add", call.input, CREATE_MS);

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

/** Its bot's body, from the shapes (BOT_SHAPES). */
export const setBotShape = async (hub: Hub, p: ProjectRef, avatarShape: string): Promise<Result<null>> => {
  const r = await hub.call("project_settings_set", { ...ref(p), avatarShape });
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

/** Picks the profile its lead runs on, switching at its next idle moment; undefined: the hub's lead profile again. */
export const setLeadProfile = async (hub: Hub, p: ProjectRef, name: string | undefined): Promise<Result<null>> => {
  const r = await hub.call("project_set", { ...ref(p), ...(name === undefined ? { leadDefault: true } : { leadProfile: name }) });
  return r.ok ? { ok: true, value: null } : r;
};

/** Starts its lead on `model`, which no profile runs on yet: a profile is made on it (named for it, at high effort),
 * and its lead picks that. */
export const startLeadOn = async (hub: Hub, p: ProjectRef, model: string, profiles: ReadonlyArray<{ name: string }>): Promise<Result<null>> => {
  const name = profileNameFor(model, profiles);
  const made = await hub.call("profile_create", { name, note: "", model, effort: "high", fast: false });
  if (!made.ok) return made;
  return setLeadProfile(hub, p, name);
};

/** Starts its lead again on its lead profile now, or once its turn ends. */
export const restartLead = async (hub: Hub, p: ProjectRef): Promise<Result<null>> => {
  const r = await hub.call("project_set", { ...ref(p), leadRestart: true });
  return r.ok ? { ok: true, value: null } : r;
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

/** One repo's settings for its Computer: its setup and its image; the bot's own directory's without `repo`. */
export const readComputer = async (hub: Hub, p: ProjectRef, repo?: string): Promise<Result<ProjectSettings>> => {
  const r = await hub.call("project_settings_get", { ...ref(p), ...(repo === undefined ? {} : { repo }) });
  return r.ok ? { ok: true, value: r.output.settings } : r;
};

/** Where every agent of the bot runs from now on: one of its choices, or null for Automatic (no pick). */
export const pickComputer = async (hub: Hub, p: ProjectRef, pick: ComputerPick | null): Promise<Result<ProjectSettings>> => {
  const r = await hub.call("project_settings_set", { ...ref(p), ...(pick === null ? { computerDefault: true } : { computer: pick }) });
  return r.ok ? { ok: true, value: r.output.settings } : r;
};

/** Builds its image again in the background; the hub answers with it building. */
export const rebuildImage = async (hub: Hub, p: ProjectRef, repo?: string): Promise<Result<ComputerImage>> => {
  const r = await hub.call("project_image_rebuild", { ...ref(p), ...(repo === undefined ? {} : { repo }) });
  return r.ok ? { ok: true, value: r.output.image } : r;
};

/** Who merges its PRs from now on: people (You) or fleetd's merge train. */
export const setWhoMerges = async (hub: Hub, p: ProjectRef, merges: Merger): Promise<Result<null>> => {
  const r = await hub.call("project_settings_set", { ...ref(p), merges });
  return r.ok ? { ok: true, value: null } : r;
};

/** Its risk rules, as the hub keeps them (the defaults until a person edits them); an older hub's are none. */
export const readRules = async (hub: Hub, p: ProjectRef): Promise<Result<RiskRules | undefined>> => {
  const r = await hub.call("project_settings_get", ref(p));
  return r.ok ? { ok: true, value: r.output.settings.mergeRules } : r;
};

/** How the train merges its PRs from now on: test, then merge, or merge, then verify. */
export const setMergeMode = async (hub: Hub, p: ProjectRef, mergeMode: MergeMode): Promise<Result<null>> => {
  const r = await hub.call("project_settings_set", { ...ref(p), mergeMode });
  return r.ok ? { ok: true, value: null } : r;
};

/** The bases of its repos that require branches up to date, while it merges, then verifies; an older hub's are none. */
export const readUpToDate = async (hub: Hub, p: ProjectRef): Promise<Result<UpToDateRule[]>> => {
  const r = await hub.call("project_settings_get", ref(p));
  return r.ok ? { ok: true, value: r.output.settings.upToDate ?? [] } : r;
};

/** Turns off "require branches to be up to date" on `repo`'s main, and nothing else of its rules (an admin's). */
export const turnOffUpToDate = async (hub: Hub, p: ProjectRef, repo: string): Promise<Result<null>> => {
  const r = await hub.call("project_settings_set", { ...ref(p), upToDateOff: repo });
  return r.ok ? { ok: true, value: null } : r;
};

/** Replaces its risk rules; the hub says which rule it can't take. */
export const setRules = async (hub: Hub, p: ProjectRef, mergeRules: RiskRules): Promise<Result<null>> => {
  const r = await hub.call("project_settings_set", { ...ref(p), mergeRules });
  return r.ok ? { ok: true, value: null } : r;
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
