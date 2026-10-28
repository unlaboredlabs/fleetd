// The home list, as plain view data: what needs you on top, then your Navis, then the projects, each by title. A
// project wants you as the desktop's sidebar says (screens/shell/model.ts): a secret or an approval open for it, or
// its lead waiting for your reply. An archived Navi is in none of them. Pure, so it is unit-tested.
import { isArchived, isNavi, type HumanRequest, type ProjectSummary } from "./desktop";
import { keyOf, type Key, type State } from "./store";

export interface Row {
  readonly key: Key;
  readonly project: ProjectSummary;
  readonly navi: boolean;
  /** Why it wants you, in a few words; undefined when it doesn't. */
  readonly want: string | undefined;
  readonly working: boolean;
}

export interface Lists {
  readonly needsYou: readonly Row[];
  readonly navis: readonly Row[];
  readonly projects: readonly Row[];
}

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

const wantOf = (key: Key, needsYou: boolean, requests: readonly HumanRequest[] | undefined): string | undefined => {
  const open = requests?.filter((r) => r.state === "open" && keyOf(r.projectRef) === key) ?? [];
  const secrets = open.filter((r) => r.kind === "secret").length;
  const approvals = open.filter((r) => r.kind === "approval").length;
  if (approvals > 0) return `${plural(approvals, "approval", "approvals")} waiting`;
  if (secrets > 0) return `${plural(secrets, "secret", "secrets")} to enter on the desktop`;
  return needsYou ? "Waiting for your reply" : undefined;
};

const byTitle = (a: Row, b: Row): number => a.project.title.localeCompare(b.project.title) || a.key.localeCompare(b.key);

/** Undefined until the projects loaded: not "no projects". */
export const lists = (s: Pick<State, "projects" | "chatStates" | "requests">): Lists | undefined => {
  if (s.projects === undefined) return undefined;
  const rows = Object.entries(s.projects)
    .filter(([, p]) => !(isNavi(p) && isArchived(p)))
    .map(([key, project]): Row => {
      const chat = s.chatStates[key];
      return { key, project, navi: isNavi(project), want: wantOf(key, chat?.needsYou === true, s.requests), working: chat?.leadWorking === true };
    })
    .sort(byTitle);
  const calm = rows.filter((r) => r.want === undefined);
  return {
    needsYou: rows.filter((r) => r.want !== undefined),
    navis: calm.filter((r) => r.navi),
    projects: calm.filter((r) => !r.navi),
  };
};

/** The open approvals, oldest first: the order they were asked in. */
export const approvals = (requests: readonly HumanRequest[] | undefined): readonly HumanRequest[] =>
  (requests ?? []).filter((r) => r.kind === "approval" && r.state === "open").sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** What an approval asks, as the card's lines: a heading, then each field in full, nothing summarised away. */
export interface ApprovalView {
  readonly title: string;
  readonly fields: ReadonlyArray<{ readonly label: string; readonly value: string; readonly mono?: boolean }>;
}

const list = (xs: readonly string[] | undefined): string | undefined => (xs === undefined || xs.length === 0 ? undefined : xs.join(", "));

export const approvalView = (r: HumanRequest, projectTitle: string | undefined): ApprovalView => {
  const fields: Array<{ label: string; value: string; mono?: boolean }> = [];
  const add = (label: string, value: string | undefined, mono = false) => {
    if (value !== undefined && value !== "") fields.push(mono ? { label, value, mono } : { label, value });
  };
  const who = projectTitle ?? r.projectRef.projectId;
  const preview = r.permission?.preview;
  let title: string;
  if (r.gated !== undefined) {
    title = `${who} wants to run a command`;
    add("Why", r.gated.reason);
    add("Command", r.gated.argv.join(" "), true);
    add("In", r.gated.cwd, true);
    add("Kind", r.gated.class);
    add("Secrets", list(r.gated.secretEnv?.map((e) => e.name)));
  } else if (preview !== undefined) {
    // The hub words it to follow "<the Navi> wants to": "Send an email".
    title = `${who} wants to ${preview.title.charAt(0).toLowerCase()}${preview.title.slice(1)}`;
    add("As", preview.account);
    add("To", list(preview.to));
    add("Cc", list(preview.cc));
    add("Bcc", list(preview.bcc));
    add("Reaches", preview.audience);
    add("Subject", preview.subject);
    add("On", preview.target);
    add("When", preview.when);
    add("Body", preview.body);
    add("Attachments", list(preview.attachments?.map((a) => a.name)));
    add("Input", preview.input, true);
  } else if (r.permission !== undefined) {
    title = r.permission.site !== undefined ? `${who} wants to visit ${r.permission.site}` : `${who} wants to use ${r.permission.toolName}`;
    add("What", r.permission.summary, true);
    if (r.permission.input !== undefined) add("Input", JSON.stringify(r.permission.input, null, 2), true);
  } else if (r.previewConfig !== undefined) {
    title = `${who} proposes how Try it runs this project`;
    add("Setting", JSON.stringify(r.previewConfig, null, 2), true);
  } else {
    title = `${who} asks for approval`;
  }
  add("Asked", r.text);
  return { title, fields };
};
