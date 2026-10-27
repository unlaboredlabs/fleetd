// What the panel's browser sessions show, as plain view data: a session's state in words and as a glyph, the list's
// groups (needs you, live, recent), how long it ran, where it is, one line per step of its action log, and a step's
// page snapshot as lines of structure. hub.ts makes it from the hub's sessions and recordings (contracts browser.rs).
// Pure, so it is unit-tested.
import type { AgentRole, GlyphState } from "../../ui";
import type { ProjectKey } from "../shell/routes";
import { fmtElapsed, parseMs } from "../live/format";

/**
 * Where a session stands. `asking`: the agent asked a person to take over, and waits. `yours`: a person took over; the
 * agent waits and sees the page as they leave it. `handingBack`: until the agent's next step sees the page. `saving`:
 * ended, its recording on its way to the hub. `lost`: the node couldn't record or upload it. `expired`: retention
 * deleted its recording.
 */
export type SessionState = "starting" | "running" | "asking" | "yours" | "handingBack" | "saving" | "ended" | "lost" | "expired";

/** A rectangle in the video frame's pixels, from its top left corner. */
export interface FrameBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The video frame's size (contracts browser.rs): a FrameBox is in its pixels. */
export const FRAME = { width: 1280, height: 800 } as const;

/** Where a login came from: a 1Password reference, resolved on the node. The value never leaves it. */
export interface CredentialRef {
  readonly site: string;
  readonly source: "1password";
}

/**
 * One element of a page snapshot, in document order: its role, its accessible name and its value, `depth` under the
 * page. A field holding a secret (a password, a code a person typed) has `secret`, never its value: the node redacts it
 * before the snapshot leaves it.
 */
export interface SnapshotNode {
  readonly depth: number;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly secret?: "vault" | "person";
}

/** The page's structure as a step found it, and the elements the step acted on (indexes into `nodes`). */
export interface PageSnapshot {
  readonly nodes: readonly SnapshotNode[];
  readonly targets: readonly number[];
}

export type ActionKind =
  | "start"
  | "open"
  | "click"
  | "type"
  | "press"
  | "fill_login"
  | "read"
  | "wait"
  | "ask"
  | "take_over"
  | "hand_back"
  | "resume"
  | "end"
  | "fail"
  /** Any other command: its verb in `text`, what it named in `target`. */
  | "command";

/**
 * One step of the action log, `at` ms after the session started. What a person types while in control is never logged,
 * only where they typed: it may be a code or a password.
 */
export interface SessionAction {
  readonly at: number;
  readonly by: "agent" | "person";
  readonly kind: ActionKind;
  /** The link, button or field: a URL for `open`, a label otherwise. */
  readonly target?: string;
  /** What the agent typed (`type`), what it read (`read`), or the reason it asked or stopped (`ask`, `fail`). */
  readonly text?: string;
  readonly credential?: CredentialRef;
  /** False when the step failed. */
  readonly ok?: boolean;
  /** The CSS selector of what it acted on (as the node read it, or as the command named it): found in its snapshot. */
  readonly selector?: string;
  /** Where what it acted on was, in the video frame's pixels (1280×800): outlined on the video at its moment. */
  readonly box?: FrameBox;
  /** The page as this step found it, as structure, or as the HTML the node read (dom.jsonl), parsed when opened. */
  readonly snapshot?: PageSnapshot;
  readonly page?: { readonly url: string; readonly title: string; readonly html: string };
}

export interface BrowserSession {
  readonly id: string;
  readonly projectRef: ProjectKey;
  /** Its agent; the role unknown for one that has finished. */
  readonly agent: { readonly laneId: string; readonly title: string; readonly role?: AgentRole };
  /** Why the agent opened it, in its words. */
  readonly purpose: string;
  readonly state: SessionState;
  readonly startedAt: string;
  readonly endedAt?: string;
  /** Why the agent asks you to take over, while it does. */
  readonly handoff?: { readonly reason: string; readonly at: number };
  /** What the agent is doing now, while it drives. */
  readonly now?: string;
  readonly actions: readonly SessionAction[];
  /** Once recorded: how long it ran, and which files the hub has (its video only where the node had ffmpeg). */
  readonly recording?: { readonly durationMs: number; readonly files: readonly ("actions" | "dom" | "video" | "video_mp4")[] };
  /** How many logins the node filled from 1Password; never their values. */
  readonly credentialsFilled?: number;
  /** Why it was lost, or what its recording lacks. */
  readonly note?: string;
}

export const STATE_WORD: Readonly<Record<SessionState, string>> = {
  starting: "starting",
  running: "live",
  asking: "needs you",
  yours: "you’re in control",
  handingBack: "handing back",
  saving: "saving",
  ended: "ended",
  lost: "lost",
  expired: "expired",
};

export const STATE_TONE = {
  starting: "quiet",
  running: "default",
  asking: "warning",
  yours: "default",
  handingBack: "default",
  saving: "quiet",
  ended: "quiet",
  lost: "danger",
  expired: "quiet",
} as const;

/** Its glyph: the agent at work is grain; a person in control holds the agent paused; asking is the solid block. */
export const glyphOf = (state: SessionState): GlyphState => {
  switch (state) {
    case "starting":
      return "thinking";
    case "running":
      return "working";
    case "asking":
      return "waiting";
    case "yours":
      return "paused";
    case "handingBack":
    case "saving":
      return "thinking";
    case "ended":
    case "expired":
      return "done";
    case "lost":
      return "failed";
  }
};

const LIVE: ReadonlySet<SessionState> = new Set(["starting", "running", "asking", "yours", "handingBack"]);

export const isLive = (s: Pick<BrowserSession, "state">): boolean => LIVE.has(s.state);

/** The host of the first page it opened; "" before its steps are known (a live one's come with its recording). */
export const siteOf = (s: Pick<BrowserSession, "actions">): string => {
  const url = s.actions.find((a) => a.kind === "open")?.target ?? "";
  if (url === "") return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** How long it ran: to its end, or to `now` while it is live. */
export const durationOf = (s: Pick<BrowserSession, "startedAt" | "endedAt" | "recording">, now: number): number => {
  if (s.recording !== undefined) return s.recording.durationMs;
  const start = parseMs(s.startedAt) ?? now;
  return Math.max(0, (parseMs(s.endedAt) ?? now) - start);
};

/** `0:42`, `4:12`, `1h 05m`. */
export const fmtDuration = fmtElapsed;

/** A list line: the sessions under it share a group. */
export interface SessionGroup {
  readonly group: "asking" | "live" | "recent";
  readonly title: string;
  readonly sessions: readonly BrowserSession[];
}

/** Those asking you first, then the live ones (oldest first, so a row stays put), then the ended (newest first). */
export const sessionGroups = (sessions: readonly BrowserSession[]): readonly SessionGroup[] => {
  const by = (a: BrowserSession, b: BrowserSession) => (parseMs(a.startedAt) ?? 0) - (parseMs(b.startedAt) ?? 0);
  const asking = sessions.filter((s) => s.state === "asking").toSorted(by);
  const live = sessions.filter((s) => isLive(s) && s.state !== "asking").toSorted(by);
  const recent = sessions.filter((s) => !isLive(s)).toSorted((a, b) => by(b, a));
  const groups: SessionGroup[] = [
    { group: "asking", title: "Needs you", sessions: asking },
    { group: "live", title: "Live", sessions: live },
    { group: "recent", title: "Recent", sessions: recent },
  ];
  return groups.filter((g) => g.sessions.length > 0);
};

/** A step in words: the verb, then what it acted on (a URL or a label in mono, quoted words in prose). */
export interface ActionLine {
  readonly who: "agent" | "you";
  readonly words: string;
  /** A URL or path, shown in mono after the words. */
  readonly machine?: string;
  readonly tone: "default" | "quiet" | "warning" | "danger";
  /** A login filled from a vault: shown with a key. */
  readonly login?: true;
}

const path = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
};

const VAULT = { "1password": "1Password" } as const;

export const actionLine = (a: SessionAction): ActionLine => {
  const line = wordsOf(a);
  // A step that failed says so, in the danger colour.
  return a.ok === false ? { ...line, words: `${line.words} · failed`, tone: "danger" } : line;
};

const wordsOf = (a: SessionAction): ActionLine => {
  const who = a.by === "person" ? "you" : "agent";
  const target = a.target ?? "";
  // A selector or an agent-browser ref is machine text: in mono after the words.
  const named = (words: string): ActionLine => ({ who, words, ...(target === "" ? {} : { machine: target }), tone: "default" });
  switch (a.kind) {
    case "start":
      return { who, words: "Started a fresh browser", tone: "quiet" };
    case "press":
      return { who, words: `Pressed ${target}`, tone: "default" };
    case "wait":
      return named("Waited for");
    case "command":
      return named(a.text ?? "Ran");
    case "open":
      return { who, words: who === "you" ? "You opened" : "Opened", machine: path(target), tone: "default" };
    case "click":
      // A selector or ref in mono; a button's own words in quotes.
      if (a.selector !== undefined || target.startsWith("@")) return named(who === "you" ? "You clicked" : "Clicked");
      return { who, words: `${who === "you" ? "You clicked" : "Clicked"} “${target}”`, tone: "default" };
    case "type":
      // A person's keys are never logged, only the field they went to.
      if (who === "you") return { who, words: `You typed in ${target}`, tone: "default" };
      if (a.selector !== undefined || target.startsWith("@")) return named(`Typed “${a.text ?? ""}” in`);
      return { who, words: `Typed “${a.text ?? ""}” in ${target}`, tone: "default" };
    case "fill_login":
      return { who, words: `Filled login for ${a.credential?.site ?? target} from ${VAULT[a.credential?.source ?? "1password"]}`, tone: "default", login: true };
    case "read":
      return { who, words: a.text === undefined ? `Read ${target}` : `Read ${target}: ${a.text}`, tone: "default" };
    case "ask":
      return { who, words: `Asked you to take over: ${a.text ?? ""}`, tone: "warning" };
    case "take_over":
      return { who: "you", words: "You took over", tone: "quiet" };
    case "hand_back":
      return { who: "you", words: "You handed back", tone: "quiet" };
    case "resume":
      return { who, words: a.text === undefined ? "Looked at the page again" : `Looked at the page again: ${a.text}`, tone: "quiet" };
    case "end":
      return { who, words: a.text === undefined ? "Ended the screen" : `Ended the screen: ${a.text}`, tone: "quiet" };
    case "fail":
      return { who, words: `Stopped: ${a.text ?? "the page failed"}`, tone: "danger" };
  }
};

/** The step a replay is on `at` ms in: the last one taken by then; -1 before the first. */
export const stepAt = (actions: readonly SessionAction[], at: number): number => {
  let index = -1;
  actions.forEach((a, i) => {
    if (a.at <= at) index = i;
  });
  return index;
};

/** What a session's own line says: why it waits, what the agent does now, or how it ended. */
export const nowLine = (s: BrowserSession): string => {
  switch (s.state) {
    case "starting":
      return "Opening a fresh browser";
    case "running":
      return s.now ?? "Working in the page";
    case "asking":
      return "Waiting for you to take over";
    case "yours":
      return "Waits, and sees the page as you leave it";
    case "handingBack":
      return "Looking at the page as you left it";
    case "saving":
      return "Saving the recording";
    case "lost":
      return s.note ?? "Its recording was lost";
    case "expired":
      return "Its recording expired";
    case "ended": {
      const last = s.actions.at(-1);
      return last === undefined ? STATE_WORD[s.state] : actionLine(last).words;
    }
  }
};

/** The stretches a person had the page, `[from, to)` in ms: from each take over to its hand back (or the end). */
export const spans = (actions: readonly SessionAction[], end: number): Array<readonly [number, number]> => {
  const out: Array<readonly [number, number]> = [];
  let from: number | undefined;
  for (const a of actions) {
    if (a.kind === "take_over") from = a.at;
    if (a.kind === "hand_back" && from !== undefined) {
      out.push([from, a.at]);
      from = undefined;
    }
  }
  if (from !== undefined) out.push([from, end]);
  return out;
};

/** A snapshot node as one line: its role, its name in quotes, then its value; a secret says where it came from. */
export const nodeLine = (n: SnapshotNode): { readonly role: string; readonly name?: string; readonly value?: string; readonly hidden?: string } => ({
  role: n.role,
  ...(n.name === undefined ? {} : { name: `“${n.name}”` }),
  ...(n.secret === "vault" ? { hidden: "filled from 1Password, hidden" } : n.secret === "person" ? { hidden: "typed by you, hidden" } : n.value === undefined ? {} : { value: n.value }),
});

/** What the step did to its target, for the highlighted line: "clicked", "typed in", "filled", "read". */
export const TARGET_WORD: Readonly<Partial<Record<ActionKind, string>>> = {
  click: "clicked",
  type: "typed in",
  fill_login: "filled",
  read: "read",
  wait: "waited for",
};
