// Finished work in words, the same on the desktop and the phone (app/mobile, through its src/desktop.ts): how an agent
// ended and how long it ran, its files by name, and what a lead turn that is over did (agents started, files they
// changed, links opened). Its stamp, "Done in 3m 10s · 3 agents" or "Worked for 27s", is stamp.ts's. Pure.
import type { Task, TaskFile, TaskState } from "./contracts";
import { workedFor } from "./turnWords";

export { agentsWord, turnStamp } from "./stamp";

/** How an agent ended, in one word; undefined while it hasn't. */
export const endedWord = (state: TaskState): "Finished" | "Failed" | "Stopped" | undefined =>
  state === "done" ? "Finished" : state === "failed" ? "Failed" : state === "cancelled" ? "Stopped" : undefined;

/** How long it ran, start to end: "12m 40s"; undefined when either end is unknown. */
export const ranFor = (task: Pick<Task, "startedAt" | "endedAt" | "createdAt">): string | undefined => {
  const start = Date.parse(task.startedAt ?? task.createdAt);
  const end = Date.parse(task.endedAt ?? "");
  return Number.isNaN(start) || Number.isNaN(end) || end < start ? undefined : workedFor(end - start);
};

/** A path as its file's name and the folder it is in ("" at the top). */
export const fileParts = (path: string): { readonly name: string; readonly dir: string } => {
  const parts = path.split("/").filter((p) => p !== "");
  return { name: parts.at(-1) ?? path, dir: parts.slice(0, -1).join("/") };
};

/** "+12 −3"; "+12" or "−3" with nothing on the other side; "" for none at all (a binary file). */
export const changeStat = (additions: number, deletions: number): string =>
  [additions > 0 ? `+${String(additions)}` : "", deletions > 0 ? `−${String(deletions)}` : ""].filter((s) => s !== "").join(" ");

/** The lines a set of files adds and removes. */
export const changeTotals = (files: readonly Pick<TaskFile, "additions" | "deletions">[]): { readonly additions: number; readonly deletions: number } =>
  files.reduce((t, f) => ({ additions: t.additions + f.additions, deletions: t.deletions + f.deletions }), { additions: 0, deletions: 0 });

/** An agent a turn started, or the order it closed had, as its list shows it. */
export interface TurnAgent {
  readonly taskId: string;
  readonly title: string;
  readonly state: TaskState;
  /** "Finished · 1m 20s", "Working". */
  readonly line: string;
}

/** A link a turn opened: a page an agent's screen or the lead's reading went to. */
export interface TurnLink {
  readonly url: string;
  /** Its site, "en.wikipedia.org": a page title when one is known, never the whole URL. */
  readonly label: string;
}

/** What a turn did: the agents it started (the order's, for the reply that closes one), their files and the links opened. */
export interface TurnList {
  readonly agents: readonly TurnAgent[];
  readonly files: readonly TaskFile[];
  readonly links: readonly TurnLink[];
}

/** A turn agent's line: how it ended and how long it ran, else where it stands. */
export const turnAgentLine = (task: Pick<Task, "state" | "startedAt" | "endedAt" | "createdAt">): string => {
  const ended = endedWord(task.state);
  if (ended !== undefined) {
    const ran = ranFor(task);
    return ran === undefined ? ended : `${ended} · ${ran}`;
  }
  return task.state === "queued" ? "Queued" : task.state === "idle" ? "Waiting" : "Working";
};

/** The http(s) URLs in a step's words, trailing punctuation off. */
export const urlsIn = (text: string): string[] =>
  [...text.matchAll(/https?:\/\/[^\s"'<>()`]+/gu)].map((m) => m[0].replace(/[.,;:!?\]]+$/u, ""));

/** A URL's site, "en.wikipedia.org", for a link with no title. */
export const siteOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
};

/**
 * A turn's list: its agents (each once, in the order they started), the files they changed (each path once, its lines
 * added up), and its links (each URL once).
 */
export const turnList = (tasks: readonly Task[], links: readonly TurnLink[]): TurnList => {
  const byPath = new Map<string, TaskFile>();
  for (const t of tasks) {
    for (const f of t.result?.files ?? []) {
      const had = byPath.get(f.path);
      byPath.set(f.path, had === undefined ? f : { path: f.path, additions: had.additions + f.additions, deletions: had.deletions + f.deletions });
    }
  }
  const seen = new Set<string>();
  const once = (l: TurnLink): boolean => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  };
  return {
    agents: [...tasks]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((t) => ({ taskId: t.taskId, title: t.title, state: t.state, line: turnAgentLine(t) })),
    files: [...byPath.values()],
    links: links.filter(once),
  };
};
