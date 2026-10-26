// What the panel's browser sessions show, as plain view data: a session's state in words and as a glyph, the list's
// groups (needs you, live, recent), how long it ran, where it is, one line per step of its action log, and a step's
// page snapshot as lines of structure. The session's shape is the broker's likely contract (T514 defines the real one):
// an id, its agent, its purpose, its state, the frames it recorded and its action log, each step with a snapshot of the
// page it acted on. Pure, so it is unit-tested.
import type { AgentRole, GlyphState } from "../../ui";
import type { ProjectKey } from "../shell/routes";
import { fmtElapsed, parseMs } from "../live/format";

/**
 * Where a session stands. `asking`: the agent asked a person to take over, and waits. `yours`: a person took over; the
 * agent waits and sees the page as they leave it.
 */
export type SessionState = "starting" | "running" | "asking" | "yours" | "ended" | "failed";

/** One picture of the page, `at` ms after the session started. A frame is a screenshot (JPEG) on the hub. */
export interface SessionFrame {
  readonly at: number;
  readonly url: string;
  readonly image: string;
}

/** Where a login came from: a 1Password reference, resolved on the node. The value never leaves it. */
export interface CredentialRef {
  readonly site: string;
  readonly source: "1password";
}

/** Where an element is on the page, in the page's own pixels (the frame's size). */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
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
  readonly box?: Box;
}

/** The page's structure as a step found it, and the elements the step acted on (indexes into `nodes`). */
export interface PageSnapshot {
  /** The page's size in its pixels, for placing `box`. */
  readonly page: { readonly width: number; readonly height: number };
  readonly nodes: readonly SnapshotNode[];
  readonly targets: readonly number[];
}

export type ActionKind = "open" | "click" | "type" | "fill_login" | "read" | "ask" | "take_over" | "hand_back" | "resume" | "end" | "fail";

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
  /** The page as this step found it; once the session has ended. */
  readonly snapshot?: PageSnapshot;
}

export interface BrowserSession {
  readonly id: string;
  readonly projectRef: ProjectKey;
  readonly agent: { readonly laneId: string; readonly title: string; readonly role: AgentRole };
  /** Why the agent opened it, in its words. */
  readonly purpose: string;
  readonly state: SessionState;
  readonly startedAt: string;
  readonly endedAt?: string;
  /** Why the agent asks you to take over, while it does. */
  readonly handoff?: { readonly reason: string; readonly at: number };
  /** What the agent is doing now, while it drives. */
  readonly now?: string;
  readonly frames: readonly SessionFrame[];
  readonly actions: readonly SessionAction[];
  /** Once ended: the video and the full trace on the hub. */
  readonly recording?: { readonly video: string; readonly trace: string; readonly durationMs: number };
}

export const STATE_WORD: Readonly<Record<SessionState, string>> = {
  starting: "starting",
  running: "live",
  asking: "needs you",
  yours: "you’re in control",
  ended: "ended",
  failed: "failed",
};

export const STATE_TONE = { starting: "quiet", running: "default", asking: "warning", yours: "default", ended: "quiet", failed: "danger" } as const;

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
    case "ended":
      return "done";
    case "failed":
      return "failed";
  }
};

export const isLive = (s: Pick<BrowserSession, "state">): boolean => s.state !== "ended" && s.state !== "failed";

/** The host of its page now (the last frame's), or of the first page it opened. */
export const siteOf = (s: Pick<BrowserSession, "frames" | "actions">): string => {
  const url = s.frames.at(-1)?.url ?? s.actions.find((a) => a.kind === "open")?.target ?? "";
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
  const who = a.by === "person" ? "you" : "agent";
  const target = a.target ?? "";
  switch (a.kind) {
    case "open":
      return { who, words: who === "you" ? "You opened" : "Opened", machine: path(target), tone: "default" };
    case "click":
      return { who, words: `${who === "you" ? "You clicked" : "Clicked"} “${target}”`, tone: "default" };
    case "type":
      // A person's keys are never logged, only the field they went to.
      return who === "you" ? { who, words: `You typed in ${target}`, tone: "default" } : { who, words: `Typed “${a.text ?? ""}” in ${target}`, tone: "default" };
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
      return { who, words: a.text === undefined ? "Ended the session" : `Ended the session: ${a.text}`, tone: "quiet" };
    case "fail":
      return { who, words: `Stopped: ${a.text ?? "the page failed"}`, tone: "danger" };
  }
};

/** The frame on screen `at` ms in: the last one taken by then (the first, before it). */
export const frameAt = (frames: readonly SessionFrame[], at: number): SessionFrame | undefined => {
  let shown = frames[0];
  for (const f of frames) {
    if (f.at > at) break;
    shown = f;
  }
  return shown;
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
    case "ended":
    case "failed": {
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
};
