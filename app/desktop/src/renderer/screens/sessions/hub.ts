// The Sessions views' data from the hub (contracts browser.rs): a project's sessions (browser_sessions, read again on
// each browser.session event), each as the views show it, with its agent from the agents list; and a recorded session's
// files (browser_recording_get, a piece at a time): its steps (actions.jsonl), the page after each step (dom.jsonl) and
// its video. Only from a hub that says it serves sessions (`browser_sessions` in its ready frame).
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { BrowserSession as HubSession, ProjectRef } from "../../../shared/contracts";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { selectLiveAgents, type LiveAgent } from "../../src/data/selectors";
import { parseMs } from "../live/format";
import type { ProjectKey } from "../shell/routes";
import type { BrowserSession, SessionAction, SessionState } from "./model";

/** The hub feature that says it serves sessions (panel/tabs.ts gates the view on it too). */
export const FEATURE = "browser_sessions";

/** Where a hub session stands, as the views say it; a state from a newer hub reads as ended. */
export const viewState = (row: Pick<HubSession, "state" | "control" | "takeoverReason">): SessionState => {
  switch (row.state) {
    case "live":
      if (row.control === "human") return "yours";
      if (row.control === "handing_back") return "handingBack";
      return row.takeoverReason === undefined ? "running" : "asking";
    case "uploading":
      return "saving";
    case "recorded":
      return "ended";
    case "lost":
      return "lost";
    case "expired":
      return "expired";
    default:
      return "ended";
  }
};

export type SessionAgent = BrowserSession["agent"];

/** The agent that opened it: its task's, or the project's lead; a finished one the list no longer has, unnamed. */
export const agentOf = (agents: readonly LiveAgent[] | undefined, row: Pick<HubSession, "taskId" | "threadId" | "projectRef">): SessionAgent => {
  const found = agents?.find((a) => (row.taskId === undefined ? a.row.threadRef?.threadId === row.threadId : a.row.taskId === row.taskId));
  if (found !== undefined) return { laneId: found.row.laneId, title: found.row.title, role: found.row.role };
  if (row.taskId === undefined) return { laneId: `lead:${row.projectRef.machineId}/${row.projectRef.projectId}`, title: "Lead", role: "lead" };
  return { laneId: row.taskId, title: "Its agent" };
};

type RecordedFile = "actions" | "dom" | "video" | "video_mp4";
const RECORDED: ReadonlySet<string> = new Set<RecordedFile>(["actions", "dom", "video", "video_mp4"]);
const isRecorded = (file: string): file is RecordedFile => RECORDED.has(file);

/** A hub session as the views show it: no frames or steps until its recording is read. */
export const fromHub = (row: HubSession, agent: SessionAgent): BrowserSession => {
  const start = parseMs(row.startedAt);
  const end = parseMs(row.endedAt);
  const files = (row.files ?? []).map((f) => f.file).filter(isRecorded);
  return {
    id: row.sessionId,
    projectRef: row.projectRef,
    agent,
    purpose: row.purpose,
    state: viewState(row),
    startedAt: row.startedAt,
    ...(row.endedAt === undefined ? {} : { endedAt: row.endedAt }),
    ...(row.takeoverReason === undefined ? {} : { handoff: { reason: row.takeoverReason, at: 0 } }),
    actions: [],
    ...(files.length > 0 && start !== undefined && end !== undefined ? { recording: { durationMs: Math.max(0, end - start), files } } : {}),
    ...(row.credentialsFilled === undefined || row.credentialsFilled === 0 ? {} : { credentialsFilled: row.credentialsFilled }),
    ...(row.note === undefined ? {} : { note: row.note }),
  };
};

/** One line of actions.jsonl (contracts BrowserAction), as far as the views read it. */
export interface HubAction {
  readonly seq: number;
  readonly offsetMs: number;
  readonly tool: string;
  readonly args?: unknown;
  readonly ok: boolean;
  readonly result?: string;
  readonly url?: string;
  readonly target?: HubTarget;
}

/** The element a step acted on, as the node read it just before (contracts StepTarget). */
export interface HubTarget {
  readonly ref?: string;
  readonly selector: string;
  readonly backendNodeId?: number;
  readonly frameBox?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** One line of dom.jsonl (contracts DomSnapshot). */
export interface HubDom {
  readonly seq: number;
  readonly offsetMs: number;
  readonly url: string;
  readonly title: string;
  readonly html: string;
}

/** A command line's words, as a shell would split them (quotes and backslashes), stopping at a pipe or a `;`. */
export const shellWords = (line: string): string[] => {
  const out: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i] ?? "";
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < line.length) {
      word += line[++i] ?? "";
      started = true;
    } else if (/\s/u.test(c) || c === "|" || c === ";" || c === "&") {
      if (started) out.push(word);
      word = "";
      started = false;
      if (c !== " " && c !== "\t" && c !== "\n") out.push(c);
    } else {
      word += c;
      started = true;
    }
  }
  if (started) out.push(word);
  return out;
};

/** agent-browser's flags that take a value, before its command. */
const VALUE_FLAGS = new Set(["--session", "--profile", "--cdp", "--port", "--timeout"]);

/** What agent-browser was told in a command line (its command and what follows), or [] when it isn't one. */
export const browserWords = (command: string): string[] => {
  const words = shellWords(command);
  const at = words.findIndex((w) => w === "agent-browser" || w.endsWith("/agent-browser"));
  if (at < 0) return [];
  const rest: string[] = [];
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i] ?? "";
    if (w === "|" || w === ";" || w === "&") break;
    if (rest.length === 0 && w.startsWith("--")) {
      if (!w.includes("=") && VALUE_FLAGS.has(w)) i++;
      continue;
    }
    rest.push(w);
  }
  return rest;
};

/** A CSS selector, not one of agent-browser's own refs (`@e3`) or locators (`text=…`). */
const cssOf = (target: string | undefined): string | undefined =>
  target === undefined || target === "" || target.startsWith("@") || /^[a-z]+=/u.test(target) ? undefined : target;

const hostOf = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const field = (args: unknown, key: string): string | undefined => (typeof args === "object" && args !== null ? str((args as Record<string, unknown>)[key]) : undefined);

const COMMAND_WORDS: Readonly<Record<string, string>> = {
  hover: "Hovered over",
  check: "Checked",
  uncheck: "Unchecked",
  scroll: "Scrolled",
  scrollintoview: "Scrolled to",
  screenshot: "Took a screenshot",
  back: "Went back",
  forward: "Went forward",
  reload: "Reloaded the page",
  eval: "Ran a script in the page",
  close: "Closed the browser",
  upload: "Uploaded a file to",
  drag: "Dragged",
};

/** An agent-browser command as a step. */
const commandStep = (base: Pick<SessionAction, "at" | "by" | "ok">, words: readonly string[], result: string | undefined): SessionAction => {
  const [verb = "", a, b] = words;
  const sel = cssOf(a);
  const withSel = sel === undefined ? {} : { selector: sel };
  switch (verb.toLowerCase()) {
    case "open":
    case "goto":
    case "navigate":
      return { ...base, kind: "open", target: a ?? "" };
    case "click":
    case "dblclick":
      return { ...base, kind: "click", target: a ?? "", ...withSel };
    case "fill":
    case "type":
      return { ...base, kind: "type", target: a ?? "", text: b ?? "", ...withSel };
    case "press":
    case "key":
      return { ...base, kind: "press", target: a ?? "" };
    case "select":
      return { ...base, kind: "command", text: `Chose “${b ?? ""}” in`, target: a ?? "", ...withSel };
    case "snapshot":
      return { ...base, kind: "read", target: "the page" };
    case "get": {
      const what = words.slice(2).join(" ");
      const sel2 = cssOf(what);
      return {
        ...base,
        kind: "read",
        target: a === "text" && what !== "" ? what : `the page’s ${a ?? "contents"}`,
        ...(result === undefined ? {} : { text: result.split("\n")[0] ?? "" }),
        ...(a === "text" && sel2 !== undefined ? { selector: sel2 } : {}),
      };
    }
    case "wait":
      return { ...base, kind: "wait", target: words.slice(1).join(" "), ...withSel };
    default: {
      const said = COMMAND_WORDS[verb.toLowerCase()];
      return { ...base, kind: "command", text: said ?? verb, target: words.slice(1).join(" "), ...withSel };
    }
  }
};

/** One line of actions.jsonl as a step; the 1Password reference a fill names is never part of it. */
export const stepOf = (a: HubAction): SessionAction => {
  const step = stepWithout(a);
  const t = a.target;
  if (t === undefined) return step;
  // What the node saw the step act on outranks what the command named: a ref (`@e3`) has a selector here too.
  return { ...step, ...(t.selector === "" ? {} : { selector: t.selector }), ...(t.frameBox === undefined ? {} : { box: t.frameBox }) };
};

const stepWithout = (a: HubAction): SessionAction => {
  const base = { at: a.offsetMs, by: "agent" as const, ...(a.ok ? {} : { ok: false }) };
  switch (a.tool) {
    case "agent-browser":
      return commandStep(base, browserWords(field(a.args, "command") ?? ""), a.result);
    case "session_start":
      return { ...base, kind: "start" };
    case "session_end":
      return { ...base, kind: "end" };
    case "fill_credential": {
      const target = field(a.args, "target");
      const sel = cssOf(target);
      const site = hostOf(a.url) ?? "the page";
      return { ...base, kind: "fill_login", target: target ?? "", credential: { site, source: "1password" }, ...(sel === undefined ? {} : { selector: sel }) };
    }
    case "request_takeover":
      return { ...base, kind: "ask", text: field(a.args, "reason") ?? "" };
    case "takeover":
    case "take_over":
      return { ...base, by: "person", kind: "take_over" };
    case "handback":
    case "hand_back":
      return { ...base, by: "person", kind: "hand_back" };
    default:
      return { ...base, kind: "command", text: a.tool.replaceAll("_", " ") };
  }
};

/** The page a step found: after the step before it (an opened page: after itself), or the last read before it. */
export const pageFor = (doms: readonly HubDom[], seq: number, opened: boolean): HubDom | undefined => {
  let found: HubDom | undefined;
  for (const d of doms) if (opened ? d.seq <= seq : d.seq < seq) found = d;
  return found ?? (opened ? undefined : doms.find((d) => d.seq <= seq));
};

/** The lines of a JSONL file, each parsed; a line that isn't JSON is left out. */
export const jsonLines = <T>(text: string): T[] =>
  text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      return [JSON.parse(line) as T];
    } catch {
      return [];
    }
  });

/** A recording's steps, each with the page it found (its HTML, made into structure only when opened). */
export const stepsOf = (actions: readonly HubAction[], doms: readonly HubDom[]): SessionAction[] =>
  actions
    .toSorted((a, b) => a.seq - b.seq)
    .map((a) => {
      const step = stepOf(a);
      const page = pageFor(doms, a.seq, step.kind === "open" || step.kind === "start");
      return page === undefined ? step : { ...step, page: { url: page.url, title: page.title, html: page.html } };
    });

const EMPTY: readonly HubSession[] = [];
const ALL = {} as const;

/** A project's sessions, newest first as the hub lists them, while the hub serves them. */
export function useSessions(project: ProjectKey): readonly BrowserSession[] {
  const on = useData((st) => st.features.includes(FEATURE));
  const projectRef: ProjectRef = { machineId: project.machineId, projectId: project.projectId };
  const rows = useToolQuery("browser_sessions", { projectRef }, { enabled: on }).data?.sessions ?? EMPTY;
  // Read here too, so a session names its agent where nothing else reads the agents (a session's own window).
  useToolQuery("agents_list", ALL, { enabled: on });
  const agents = useData(selectLiveAgents);
  return useMemo(() => rows.map((row) => fromHub(row, agentOf(agents, row))), [rows, agents]);
}

/** A recorded session's files, read once (a recording never changes): its steps with their pages, and its video. */
export interface Recording {
  readonly actions: readonly SessionAction[];
  readonly video?: Blob;
}

const decode = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Reads a recording's file from the hub, a piece at a time, until it is all here. */
export function useRecording(session: BrowserSession): { readonly data?: Recording; readonly error: boolean } {
  const layer = useDataLayer();
  const files = session.recording?.files;
  const query = useQuery({
    queryKey: ["browser_recording", session.id, files],
    enabled: files !== undefined && files.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
    queryFn: async (): Promise<Recording> => {
      const read = async (file: RecordedFile): Promise<Uint8Array<ArrayBuffer>> => {
        const parts: Uint8Array[] = [];
        let offset = 0;
        // A file is at most what retention keeps; 2 000 pieces of 512 KB is past any recording's size.
        for (let i = 0; i < 2_000; i++) {
          const outcome = await layer.call("browser_recording_get", { sessionId: session.id, file, offset });
          if (!outcome.ok) throw new Error(outcome.error.message);
          const piece = decode(outcome.output.dataB64);
          parts.push(piece);
          offset += piece.length;
          if (outcome.output.done || piece.length === 0) break;
        }
        const all = new Uint8Array(offset);
        let at = 0;
        for (const p of parts) {
          all.set(p, at);
          at += p.length;
        }
        return all;
      };
      const text = async (file: RecordedFile) => (files?.includes(file) === true ? new TextDecoder().decode(await read(file)) : "");
      const [actions, doms] = await Promise.all([text("actions"), text("dom")]);
      // A browser's or an Android emulator's video is WebM; an iOS simulator's is simctl's own MP4.
      const [file, type] = files?.includes("video_mp4") === true ? (["video_mp4", "video/mp4"] as const) : (["video", "video/webm"] as const);
      const video = files?.includes(file) === true ? new Blob([await read(file)], { type }) : undefined;
      return { actions: stepsOf(jsonLines<HubAction>(actions), jsonLines<HubDom>(doms)), ...(video === undefined ? {} : { video }) };
    },
  });
  return { ...(query.data === undefined ? {} : { data: query.data }), error: query.isError };
}
