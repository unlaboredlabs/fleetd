// The home list, as plain view data: what needs you on top, then your Navis, then the projects, each by title. A
// project wants you as the desktop's sidebar says (screens/shell/model.ts): a secret or an approval open for it, or
// its lead waiting for your reply. An archived Navi is in none of them. Pure, so it is unit-tested.
import { previewOf } from "./chatView";
import { chatItems, isArchived, isNavi, type HumanRequest, type ProjectSummary } from "./desktop";
import { keyOf, type Key, type State } from "./store";

export interface Row {
  readonly key: Key;
  readonly project: ProjectSummary;
  readonly navi: boolean;
  /** Why it wants you, in a few words; undefined when it doesn't. */
  readonly want: string | undefined;
  readonly working: boolean;
  /** The open approvals it asks: the row's badge. */
  readonly approvals: number;
  /** Its newest message in one line, once its chat was read; else undefined. */
  readonly preview: string | undefined;
  /** When it last spoke, or last did anything. */
  readonly at: string;
}

export interface Lists {
  readonly needsYou: readonly Row[];
  readonly navis: readonly Row[];
  readonly projects: readonly Row[];
}

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

const openFor = (key: Key, requests: readonly HumanRequest[] | undefined, kind: HumanRequest["kind"]): number =>
  requests?.filter((r) => r.state === "open" && r.kind === kind && keyOf(r.projectRef) === key).length ?? 0;

const wantOf = (key: Key, needsYou: boolean, requests: readonly HumanRequest[] | undefined): string | undefined => {
  const secrets = openFor(key, requests, "secret");
  const approvals = openFor(key, requests, "approval");
  if (approvals > 0) return `${plural(approvals, "approval", "approvals")} waiting`;
  if (secrets > 0) return `${plural(secrets, "secret", "secrets")} to enter on the desktop`;
  return needsYou ? "Waiting for your reply" : undefined;
};

const previewFor = (s: Partial<Pick<State, "chats" | "sends">>, key: Key): string | undefined => {
  const chat = s.chats?.[key];
  if (chat === undefined) return undefined;
  const items = chatItems(chat, s.sends?.[key] ?? []).filter((i) => i.kind !== "event");
  for (let i = items.length - 1; i >= 0; i--) {
    const line = previewOf(items[i] ?? { author: "system", text: "", message: undefined });
    if (line !== "") return line;
  }
  return undefined;
};

const byTitle = (a: Row, b: Row): number => a.project.title.localeCompare(b.project.title) || a.key.localeCompare(b.key);

/** Undefined until the projects loaded: not "no projects". The chats read so far give the rows' previews. */
export const lists = (s: Pick<State, "projects" | "chatStates" | "requests"> & Partial<Pick<State, "chats" | "sends">>): Lists | undefined => {
  if (s.projects === undefined) return undefined;
  const rows = Object.entries(s.projects)
    .filter(([, p]) => !(isNavi(p) && isArchived(p)))
    .map(([key, project]): Row => {
      const chat = s.chatStates[key];
      return {
        key,
        project,
        navi: isNavi(project),
        want: wantOf(key, chat?.needsYou === true, s.requests),
        working: chat?.leadWorking === true,
        approvals: openFor(key, s.requests, "approval"),
        preview: previewFor(s, key),
        at: chat?.lastMessageAt ?? project.lastActivityAt,
      };
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

/** What an approval asks, as the card's lines: who asks and what, then each field in full, nothing summarised away. */
export interface ApprovalView {
  readonly title: string;
  /** The title in two: the asker ("Ada") and what it wants ("wants to send an email"). */
  readonly who: string;
  readonly wants: string;
  /** Marked on the card: it spends money, can't be undone, or uses a secret. */
  readonly risk: "money" | "irreversible" | "credential" | undefined;
  /**
   * `more`: context shown under Details (where a command runs, its kind, a tool's raw input). Everything that decides
   * the answer (what runs, who it reaches, as whom, what it says) is always on the card's face, in full: the card is
   * what the person approves.
   */
  readonly fields: ReadonlyArray<{ readonly label: string; readonly value: string; readonly mono?: boolean; readonly more?: boolean }>;
}

const list = (xs: readonly string[] | undefined): string | undefined => (xs === undefined || xs.length === 0 ? undefined : xs.join(", "));

export const approvalView = (r: HumanRequest, projectTitle: string | undefined): ApprovalView => {
  const fields: Array<{ label: string; value: string; mono?: boolean; more?: boolean }> = [];
  const add = (label: string, value: string | undefined, how: { mono?: boolean; more?: boolean } = {}) => {
    if (value !== undefined && value !== "") fields.push({ label, value, ...(how.mono === true ? { mono: true } : {}), ...(how.more === true ? { more: true } : {}) });
  };
  const who = projectTitle ?? r.projectRef.projectId;
  const preview = r.permission?.preview;
  let wants: string;
  let risk: ApprovalView["risk"];
  if (r.gated !== undefined) {
    wants = "wants to run a command";
    risk = r.gated.class;
    add("Why", r.gated.reason);
    add("Command", r.gated.argv.join(" "), { mono: true });
    add("In", r.gated.cwd, { mono: true, more: true });
    add("Kind", r.gated.class, { more: true });
    add("Secrets", list(r.gated.secretEnv?.map((e) => e.name)));
  } else if (preview !== undefined) {
    // The hub words it to follow "<the Navi> wants to": "Send an email".
    wants = `wants to ${preview.title.charAt(0).toLowerCase()}${preview.title.slice(1)}`;
    risk = preview.action === "spend" ? "money" : preview.action === "delete" ? "irreversible" : undefined;
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
    add("Input", preview.input, { mono: true, more: true });
  } else if (r.permission !== undefined) {
    wants = r.permission.site !== undefined ? `wants to visit ${r.permission.site}` : `wants to use ${r.permission.toolName}`;
    add("What", r.permission.summary, { mono: true });
    if (r.permission.input !== undefined) add("Input", JSON.stringify(r.permission.input, null, 2), { mono: true, more: true });
  } else if (r.previewConfig !== undefined) {
    wants = "proposes how Try it runs this project";
    add("Setting", JSON.stringify(r.previewConfig, null, 2), { mono: true });
  } else {
    wants = "asks for approval";
  }
  add("Asked", r.text);
  return { title: `${who} ${wants}`, who, wants, risk, fields };
};
