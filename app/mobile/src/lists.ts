// The home list, as plain view data: what needs you on top, then every other chat, newest first. A project wants you
// as the desktop's sidebar says (screens/shell/model.ts): a secret or an approval open for it, or its lead waiting for
// your reply. An archived project is in neither, unless an approval of its waits: it is under Archived. Pure, so it is
// unit-tested.
import { previewOf } from "./chatView";
import { chatItems, emptyChat, hasHidden, isArchived, proposal, shellWord, type Chat, type ChatItem, type ChatMessage, type HumanRequest, type ProjectChatState, type ProjectSummary } from "./desktop";
import { unreadCount, type Prefs } from "./prefs";
import { keyOf, type Key, type State } from "./store";

export interface Row {
  readonly key: Key;
  readonly project: ProjectSummary;
  /** Archived, and shown only while an approval of its waits, or under Archived. */
  readonly archived: boolean;
  /** Why it wants you, in a few words; undefined when it doesn't. */
  readonly want: string | undefined;
  readonly working: boolean;
  /** The open approvals it asks: the row's badge. */
  readonly approvals: number;
  /** Its newest message in one line, from its chat once read, else from its newest messages; undefined till then. */
  readonly preview: string | undefined;
  /** Its chat has nothing in it yet, as far as read. */
  readonly empty: boolean;
  /** When it last spoke, or last did anything. */
  readonly at: string;
}

export interface Lists {
  readonly needsYou: readonly Row[];
  readonly chats: readonly Row[];
  /** Archived, with nothing waiting for you: the Archived filter's. */
  readonly archived: readonly Row[];
}

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/**
 * Whether a request waits on you (`me`, hub_info's): it says no one in particular (`for`), or you, or who you are isn't
 * known yet. A teammate's shows in the chat, but marks only their phone.
 */
export const mine = (r: HumanRequest, me: string | undefined): boolean => r.for === undefined || me === undefined || r.for.personId === me;

/** Whether a chat's lead waits on you: it needs someone, and you are among those it is for (`needsYouFor`), or no one in particular. */
export const waitsOnMe = (chat: ProjectChatState | undefined, me: string | undefined): boolean =>
  chat?.needsYou === true && (chat.needsYouFor === undefined || me === undefined || chat.needsYouFor.includes(me));

const openFor = (key: Key, requests: readonly HumanRequest[] | undefined, kind: HumanRequest["kind"], me: string | undefined): number =>
  requests?.filter((r) => r.state === "open" && r.kind === kind && keyOf(r.projectRef) === key && mine(r, me)).length ?? 0;

const wantOf = (key: Key, needsYou: boolean, requests: readonly HumanRequest[] | undefined, me: string | undefined): string | undefined => {
  const secrets = openFor(key, requests, "secret", me);
  const approvals = openFor(key, requests, "approval", me);
  if (approvals > 0) return `${plural(approvals, "approval", "approvals")} waiting`;
  if (secrets > 0) return `${plural(secrets, "secret", "secrets")} to enter on the desktop`;
  return needsYou ? "Waiting for your reply" : undefined;
};

/**
 * What the list knows of a chat: the chat opened here, with its newest few messages after it when those are newer (a
 * chat held from an earlier link, which keeps what came since aside), or only those newest few.
 */
const knownChat = (s: Partial<Pick<State, "chats" | "latest">>, key: Key): Chat | undefined => {
  const chat = s.chats?.[key];
  const latest = s.latest?.[key];
  if (latest === undefined) return chat;
  if (chat === undefined) return { ...emptyChat, messages: [...latest] };
  const newest = chat.messages.at(-1)?.seq ?? 0;
  const later = latest.filter((m) => m.seq > newest);
  return later.length === 0 ? chat : { ...chat, messages: [...chat.messages, ...later] };
};

/**
 * Each message's line, made once: the list is drawn twice a render (all of it, and the filter's) and again on each
 * event, and a line is a markdown parse. A streamed text isn't its message's, so it's made each time.
 */
const lines = new WeakMap<ChatMessage, string>();

const lineOf = (item: ChatItem): string => {
  const m = item.message;
  if (m === undefined || item.text !== m.text) return previewOf(item);
  const known = lines.get(m);
  if (known !== undefined) return known;
  const line = previewOf(item);
  lines.set(m, line);
  return line;
};

/** How many of a chat's newest messages a preview looks through first: an opened chat holds up to 2000. */
const PREVIEW_TAIL = 20;

const previewFor = (s: Partial<Pick<State, "chats" | "sends" | "latest">>, key: Key): string | undefined => {
  const chat = knownChat(s, key);
  if (chat === undefined) return undefined;
  const sends = s.sends?.[key] ?? [];
  const newest = (c: Chat): string | undefined => {
    const items = chatItems(c, sends);
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item === undefined || item.kind === "event") continue;
      const line = lineOf(item);
      if (line !== "") return line;
    }
    return undefined;
  };
  if (chat.messages.length <= PREVIEW_TAIL) return newest(chat);
  const tail = chat.messages.slice(-PREVIEW_TAIL);
  const before = chat.messages.length - PREVIEW_TAIL;
  // A stream whose message is older than the tail isn't the newest line (chatItems would put it last).
  const older = (id: string): boolean => {
    const at = chat.messages.findIndex((m) => m.messageId === id);
    return at !== -1 && at < before;
  };
  const streams = Object.fromEntries(Object.entries(chat.streams).filter(([id]) => !older(id)));
  return newest({ ...chat, messages: tail, streams }) ?? newest(chat);
};

/** Who spoke last first, as Messages orders chats. */
const byRecent = (a: Row, b: Row): number => b.at.localeCompare(a.at) || a.project.title.localeCompare(b.project.title) || a.key.localeCompare(b.key);

/** Undefined until the projects loaded: not "no projects". The chats read so far give the rows' previews. */
export const lists = (s: Pick<State, "projects" | "chatStates" | "requests"> & Partial<Pick<State, "chats" | "sends" | "latest" | "me">>): Lists | undefined => {
  if (s.projects === undefined) return undefined;
  const rows = Object.entries(s.projects)
    .map(([key, project]): Row => {
      const chat = s.chatStates[key];
      return {
        key,
        project,
        archived: isArchived(project),
        want: wantOf(key, waitsOnMe(chat, s.me), s.requests, s.me),
        working: chat?.leadWorking === true,
        approvals: openFor(key, s.requests, "approval", s.me),
        preview: previewFor(s, key),
        empty: (s.chats?.[key]?.messages.length ?? s.latest?.[key]?.length) === 0,
        at: chat?.lastMessageAt ?? project.lastActivityAt,
      };
    })
    .sort(byRecent);
  // An archived project's approvals stay open on the hub, and count in the badges: its chat shows while one waits.
  const shown = rows.filter((r) => !r.archived || r.approvals > 0);
  return {
    needsYou: shown.filter((r) => r.want !== undefined),
    chats: shown.filter((r) => r.want === undefined),
    archived: rows.filter((r) => r.archived && r.approvals === 0),
  };
};

/**
 * A row's one line: its newest message, kept while its lead works (the glyph in front says so: a turn lasts minutes),
 * "Working…" only while it has none; else why it wants you.
 */
export const rowLine = (row: Pick<Row, "preview" | "working" | "want" | "empty">): string =>
  row.preview ?? (row.working ? "Working…" : (row.want ?? (row.empty ? "No messages yet" : "")));

/**
 * The chats list's filters, as chat apps' folders: everything, what you haven't read, the chats with an approval
 * waiting for you, the pinned ones, and the archived ones, which are in none of the others.
 */
export type Filter = "all" | "unread" | "needsYou" | "pinned" | "archived";

export interface ChatRow extends Row {
  readonly pinned: boolean;
  readonly muted: boolean;
  /** Messages from the other side since you last read it. */
  readonly unread: number;
  /** Marked unread by hand: a dot with no count. */
  readonly markedUnread: boolean;
  /** The chat's newest seq, as the hub says: what Mark as Read reads up to. */
  readonly lastSeq: number;
}

/** A chat with an approval open floats above the rest, pinned ones too: answering it is what the phone is for. */
const waitingFirst = (a: Row, b: Row): number => Number(b.approvals > 0) - Number(a.approvals > 0);

/**
 * The chats list, as chat apps keep it: one list, the chats with an approval waiting on top, then the pinned ones in the
 * order pinned, then every other chat with what spoke last first. Each says how many messages came since you read it,
 * and whether it's muted (its count goes grey). Archived projects are only under Archived, except while an approval of
 * theirs waits. `pinned`: this hub's pins, in the person's order (prefs.ts pinsOf).
 */
export const chatList = (s: Parameters<typeof lists>[0], prefs: Prefs, filter: Filter = "all", pinned: readonly Key[] = []): readonly ChatRow[] | undefined => {
  const all = lists(s);
  if (all === undefined) return undefined;
  const rows = [...(filter === "archived" ? all.archived : [...all.needsYou, ...all.chats])]
    .map((r): ChatRow => {
      const held = knownChat(s, r.key)?.messages ?? [];
      return {
        ...r,
        pinned: pinned.includes(r.key),
        muted: prefs.muted.includes(r.key),
        unread: unreadCount(prefs, r.key, s.chatStates[r.key]?.lastSeq, held),
        markedUnread: prefs.unread.includes(r.key),
        lastSeq: s.chatStates[r.key]?.lastSeq ?? 0,
      };
    })
    .sort((a, b) => waitingFirst(a, b) || (a.pinned && b.pinned ? pinned.indexOf(a.key) - pinned.indexOf(b.key) : a.pinned ? -1 : b.pinned ? 1 : byRecent(a, b)));
  switch (filter) {
    case "all":
      return rows;
    case "unread":
      return rows.filter((r) => r.unread > 0 || r.markedUnread || r.want !== undefined);
    case "needsYou":
      return rows.filter((r) => r.approvals > 0);
    case "pinned":
      return rows.filter((r) => r.pinned);
    case "archived":
      return rows;
  }
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
   * `more`: shown under Details (the raw input behind a preview), or for a command under Show command (the command
   * itself, whose reason, risk and folder stay on the card's face). Everything else that decides the answer (who it
   * reaches, as whom, what it says) is always on the card's face, in full. `prose`: the asker's own words (why), whose
   * `code` spans may be drawn as code; every other field shows exactly as written, backticks and all, as it would go
   * out. `lines`: its \n breaks the line (a body, a block of JSON, a multi-line command); anywhere else a \n is a
   * hidden character. `words`: a command's arguments, each quoted where it needs it, which the card isolates one by one.
   */
  readonly fields: ReadonlyArray<ApprovalField>;
  /** Some field holds a character that hides or reorders text (shared/hidden.ts): the card says so, and marks each. */
  readonly hidden: boolean;
}

export interface ApprovalField {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly more?: boolean;
  readonly prose?: boolean;
  readonly lines?: boolean;
  readonly words?: readonly string[];
}

/**
 * What Copy gives for a field: its exact text (a command's words quoted, as the desktop copies it), never the marks
 * and isolates the card draws it with.
 */
export const fieldCopy = (f: ApprovalField): string => f.value;

const list = (xs: readonly string[] | undefined): string | undefined => (xs === undefined || xs.length === 0 ? undefined : xs.join(", "));

export const approvalView = (r: HumanRequest, projectTitle: string | undefined): ApprovalView => {
  const fields: ApprovalField[] = [];
  const add = (label: string, value: string | undefined, how: Omit<ApprovalField, "label" | "value"> = {}) => {
    if (value !== undefined && value !== "") fields.push({ label, value, ...how });
  };
  const who = projectTitle ?? r.projectRef.projectId;
  const preview = r.permission?.preview;
  let wants: string;
  let risk: ApprovalView["risk"];
  if (r.gated !== undefined) {
    wants = "wants to run a command";
    risk = r.gated.class;
    add("Why", r.gated.reason, { prose: true, lines: true });
    // The reason is what a person approves on; the exact command, a shell blob as often as not, is one tap away.
    const words = r.gated.argv.map(shellWord);
    add("Command", words.join(" "), { mono: true, words, lines: true, more: true });
    add("In", r.gated.cwd, { mono: true });
    add("Secrets", list(r.gated.secretEnv?.map((e) => e.name)));
  } else if (preview !== undefined) {
    // The hub words it to follow "<the project> wants to": "Use create_page on docs".
    wants = `wants to ${preview.title.charAt(0).toLowerCase()}${preview.title.slice(1)}`;
    risk = preview.action === "spend" ? "money" : preview.action === "delete" ? "irreversible" : undefined;
    // A lead's proposal for a new project: all that approving it makes, on the card's face.
    const made = proposal(preview);
    if (made !== undefined) {
      add("Repo", made.repo ?? "None", made.repo === undefined ? {} : { mono: true });
      add("Folder", made.path, { mono: true });
      add("On", made.machineId);
    }
    add("Input", preview.input, { mono: true, more: true, lines: true });
  } else if (r.permission !== undefined) {
    wants = r.permission.site !== undefined ? `wants to visit ${r.permission.site}` : `wants to use ${r.permission.toolName}`;
    add("What", r.permission.summary, { mono: true });
    // The summary is a first line or a path: the input is the rest of the command, or the file's content.
    if (r.permission.input !== undefined) add("Input", JSON.stringify(r.permission.input, null, 2), { mono: true, lines: true });
  } else {
    wants = "asks for approval";
  }
  add("Asked", r.text, { lines: true });
  const hidden = hasHidden(who) || hasHidden(wants) || fields.some((f) => (f.words ?? [f.value]).some((v) => hasHidden(v, f.lines === true)));
  return { title: `${who} ${wants}`, who, wants, risk, fields, hidden };
};

/** The card's row that shows its `more` fields and hides them again: a command's own words, or Details. */
export const moreWords = (r: HumanRequest, open: boolean): string => (r.gated !== undefined ? (open ? "Hide command" : "Show command") : open ? "Less" : "Details");

/** An approval in a chat once its card is gone: how it went, in a few words. */
export interface ApprovalOutcome {
  readonly text: string;
  readonly tone: "approved" | "denied" | "failed" | "waiting";
  /** When it was answered, when known. */
  readonly at: string | undefined;
}

/**
 * The line for an approval with no open card: its message's state, or, while that still says open, the answer this
 * phone just gave (`decided`, as the hub took it), so it never reads "waiting" after you answered it.
 */
export const approvalOutcome = (
  item: { readonly state: string; readonly by?: string; readonly note?: string; readonly answeredAt?: string },
  decided: HumanRequest | undefined,
): ApprovalOutcome => {
  const [state, by, note, at] =
    item.state === "open" && decided !== undefined ? [decided.state, decided.answeredBy, undefined, decided.answeredAt] : [item.state, item.by, item.note, item.answeredAt];
  const who = by === undefined ? "" : ` by ${by.replace(/^human:/u, "")}`;
  switch (state) {
    case "open":
      return { text: "Waiting for approval", tone: "waiting", at: undefined };
    case "approved":
    case "ran":
      return { text: `Approved${who}`, tone: "approved", at };
    case "failed":
      // The hub's note may say "not run" itself ("not run on devbox: …"): said once.
      return { text: note === undefined ? `Approved${who}, but it failed` : /^not run\b/iu.test(note) ? `N${note.slice(1)}` : `Not run: ${note}`, tone: "failed", at };
    case "denied":
      return { text: note !== undefined && by === undefined ? `Closed: ${note}` : `Denied${who}`, tone: "denied", at };
    default:
      return { text: `${state.charAt(0).toUpperCase()}${state.slice(1)}`, tone: "denied", at };
  }
};
