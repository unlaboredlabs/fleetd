// The Activity feed's model: which hub events it shows and in what words, the kinds its chips filter by, and the
// rows it lays them out as (days, the "since you last looked" divider, and runs of one thing folded into one row).
// Pure, so the grouping is tested without a screen.
import type { HubEvent, HubEventType } from "../../../shared/contracts";
import { dayLabel } from "../chat/model";
import type { PanelView, PrKey } from "../shell/routes";

export type ActivityKind = "agents" | "reviews" | "merges" | "asks" | "other";

export const KINDS: readonly ActivityKind[] = ["agents", "reviews", "merges", "asks", "other"];

export const KIND_WORD: Readonly<Record<ActivityKind, string>> = {
  agents: "Agents",
  reviews: "Reviews",
  merges: "Merges",
  asks: "Asks you",
  other: "Other",
};

/** The event types each kind shows. Anything else (chat lines, presence, clone progress) is not activity. */
const TYPES: Readonly<Record<ActivityKind, readonly HubEventType[]>> = {
  agents: ["task.started", "task.completed", "task.failed", "task.cancelled"],
  reviews: ["review.verdict"],
  merges: ["change.queued", "change.needs_rebase", "change.ci_failed", "change.refused", "pr.merged", "pr.merged_outside"],
  asks: ["request.opened", "request.updated"],
  other: ["workstream.created", "workstream.done", "project.fetch_failed", "decision.recorded", "agents.cap", "key.paired"],
};

const KIND_OF: ReadonlyMap<string, ActivityKind> = new Map(KINDS.flatMap((k) => TYPES[k].map((t) => [t, k] as const)));

export const kindOf = (type: HubEventType): ActivityKind | undefined => KIND_OF.get(type);

/** The chosen kinds; none chosen is every kind. */
export type KindFilter = ReadonlySet<ActivityKind>;

export const shownKinds = (filter: KindFilter): readonly ActivityKind[] => (filter.size === 0 ? KINDS : KINDS.filter((k) => filter.has(k)));

/** The types to read for `filter`, in a stable order (they are part of the read's key). */
export const typesFor = (filter: KindFilter): HubEventType[] => shownKinds(filter).flatMap((k) => TYPES[k]);

/** Whether the read takes the hub's own events too: a device paired is Other. */
export const hubWideFor = (filter: KindFilter): boolean => filter.size === 0 || filter.has("other");

/** Whether `e` belongs in the feed of `project` under `filter`: its own events, and the hub's when Other shows. */
export const inFeed = (e: HubEvent, project: { readonly machineId: string; readonly projectId: string }, filter: KindFilter): boolean => {
  const kind = kindOf(e.type);
  if (kind === undefined || !shownKinds(filter).includes(kind)) return false;
  if (e.machineId === undefined && e.projectId === undefined) return hubWideFor(filter);
  return e.machineId === project.machineId && e.projectId === project.projectId;
};

/** What the row's icon draws. */
export type Icon =
  | "started"
  | "finished"
  | "failed"
  | "cancelled"
  | "review"
  | "queued"
  | "merged"
  | "sentBack"
  | "refused"
  | "approval"
  | "secret"
  | "answered"
  | "denied"
  | "order"
  | "orderDone"
  | "decision"
  | "warning"
  | "device"
  | "cap";

/** The icon's colour, in the status chips' vocabulary: amber is "needs you", red only for failure. */
export type Tone = "needs-you" | "failed" | "done" | "quiet";

/** One event as the feed words it. */
export interface Line {
  readonly seq: number;
  readonly at: string;
  readonly kind: ActivityKind;
  readonly icon: Icon;
  readonly tone: Tone;
  /** What happened, short: "T12 finished", "Merged #31". */
  readonly text: string;
  /** Quieter, after it: the task's title, the reason, the command. */
  readonly detail?: string | undefined;
  /** Where the row opens in the panel, when the event names an agent or a PR. */
  readonly link?: PanelView | undefined;
  /** Lines next to each other with the same `run.key` fold into one row worded by `run.label(count)`. */
  readonly run?: { readonly key: string; readonly label: (n: number) => string } | undefined;
}

const record = (v: unknown): Readonly<Record<string, unknown>> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);

/** The hub's summary after its "T12 completed: " head, which the row already says. */
const tail = (summary: string): string | undefined => {
  const at = summary.indexOf(": ");
  return at === -1 ? undefined : str(summary.slice(at + 2).trim());
};

/** "https://github.com/acme/shop/pull/31" as a PR key. */
export const prOfUrl = (url: string | undefined): PrKey | undefined => {
  const m = url === undefined ? null : /github\.com\/([^/\s]+\/[^/\s]+)\/pulls?\/(\d+)/u.exec(url);
  return m === null ? undefined : { repo: m[1] ?? null, number: Number(m[2]) };
};

const prOf = (data: Readonly<Record<string, unknown>>): PrKey | undefined => {
  const number = num(data["prNumber"]);
  if (number !== undefined) return { repo: str(data["repo"]) ?? null, number };
  return prOfUrl(str(data["prUrl"]) ?? str(data["pr"]));
};

const prView = (pr: PrKey | undefined): PanelView | undefined => (pr === undefined ? undefined : { tab: "prs", pr });

const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** `e` in the feed's words, or undefined when the feed doesn't show its type. */
export function describe(e: HubEvent): Line | undefined {
  const kind = kindOf(e.type);
  if (kind === undefined) return undefined;
  const data = record(e.data);
  const base = { seq: e.seq, at: e.at, kind };
  const taskId = str(data["taskId"]);
  const workstream = str(data["workstreamId"]);
  const agent: PanelView | undefined = taskId === undefined ? undefined : { tab: "agents", agent: taskId };
  const who = taskId ?? "An agent";
  const pr = prOf(data);
  const prWord = pr === undefined ? "a PR" : `#${pr.number}`;
  switch (e.type) {
    case "task.started":
      return {
        ...base,
        icon: "started",
        tone: "quiet",
        text: `${who} started`,
        detail: tail(e.summary),
        link: agent,
        ...(workstream === undefined ? {} : { run: { key: `started:${workstream}`, label: (n: number) => `${plural(n, "agent")} started` } }),
      };
    case "task.completed":
      return { ...base, icon: "finished", tone: "done", text: `${who} finished`, detail: tail(e.summary), link: agent };
    case "task.failed":
      return { ...base, icon: "failed", tone: "failed", text: `${who} failed`, detail: tail(e.summary), link: agent };
    case "task.cancelled":
      return { ...base, icon: "cancelled", tone: "quiet", text: `${who} stopped`, detail: tail(e.summary), link: agent };
    case "review.verdict": {
      const blocking = typeof data["blocking"] === "number" ? data["blocking"] : 0;
      const of = pr === undefined ? "Review" : `Review of #${pr.number}`;
      const subject = pr === undefined ? workstream : `${pr.repo ?? ""}#${pr.number}`;
      return {
        ...base,
        icon: "review",
        tone: blocking > 0 ? "needs-you" : "done",
        text: blocking > 0 ? `${of}: ${plural(blocking, "blocking finding")}` : `${of} passed`,
        link: prView(pr) ?? agent,
        ...(subject === undefined ? {} : { run: { key: `review:${subject}`, label: (n: number) => `${plural(n, "review")} of ${pr === undefined ? "one PR" : prWord}` } }),
      };
    }
    case "change.queued":
      return { ...base, icon: "queued", tone: "quiet", text: `${prWord} queued to merge`, link: prView(pr) };
    case "change.needs_rebase":
    case "change.ci_failed": {
      const change = str(data["changeId"]);
      const checks = Array.isArray(data["checks"]) ? data["checks"].filter((c): c is string => typeof c === "string") : [];
      return {
        ...base,
        icon: "sentBack",
        tone: "needs-you",
        text: e.type === "change.ci_failed" ? "Sent back: CI failed" : "Sent back: needs a rebase",
        detail: checks.length > 0 ? checks.join(", ") : tail(e.summary),
        link: prView(pr),
        ...(change === undefined ? {} : { run: { key: `train:${change}`, label: (n: number) => `Sent back ${plural(n, "time")}` } }),
      };
    }
    case "change.refused":
      return { ...base, icon: "refused", tone: "failed", text: `${prWord} refused by the merge train`, detail: str(data["fix"]) ?? tail(e.summary), link: prView(pr) };
    case "pr.merged": {
      const into = str(data["base"]);
      return { ...base, icon: "merged", tone: "done", text: `Merged ${prWord}${into === undefined ? "" : ` into ${into}`}`, link: prView(pr) };
    }
    case "pr.merged_outside":
      return { ...base, icon: "merged", tone: "quiet", text: `${prWord} merged outside the train`, detail: str(data["mergedBy"]), link: prView(pr) };
    case "request.opened":
    case "request.updated":
      return request(e, data, base);
    case "workstream.created":
      return { ...base, icon: "order", tone: "quiet", text: "New order", detail: tail(e.summary) };
    case "workstream.done":
      return { ...base, icon: "orderDone", tone: "done", text: "Order closed", detail: str(data["reason"]) ?? tail(e.summary) };
    case "project.fetch_failed":
      return { ...base, icon: "warning", tone: "failed", text: "Couldn’t fetch the remote", detail: tail(e.summary) ?? e.summary };
    case "decision.recorded":
      return { ...base, icon: "decision", tone: "quiet", text: "Decision recorded", detail: decision(e.summary) };
    case "agents.cap":
      return { ...base, icon: "cap", tone: "quiet", text: "Max agents changed", detail: e.summary };
    case "key.paired":
      return { ...base, icon: "device", tone: "quiet", text: "A device paired", detail: str(data["deviceName"]) };
    default:
      return undefined;
  }
}

/** "D4 merge.style = squash" without its id. */
const decision = (summary: string): string | undefined => str(summary.replace(/^D\d+\s+/u, ""));

/**
 * A secret or an approval asked for or answered. The summary names the secret by its key and the approval by its
 * command, never a value: the hub writes it so.
 */
function request(e: HubEvent, data: Readonly<Record<string, unknown>>, base: Pick<Line, "seq" | "at" | "kind">): Line {
  const secret = data["kind"] === "secret";
  const state = str(data["state"]) ?? "open";
  const what = tail(e.summary);
  const detail = secret ? what?.replace(/^secret\s+/u, "") : what;
  const id = str(data["requestId"]);
  // Folded, a request is named by what it asks for; its row says where it got to.
  const named = secret ? `Secret ${detail ?? "request"}` : `Approval: ${detail ?? "a command"}`;
  const run = id === undefined ? undefined : { key: `request:${id}`, label: () => named };
  const words: Readonly<Record<string, readonly [string, Icon, Tone]>> = secret
    ? {
        open: ["Secret asked for", "secret", "needs-you"],
        stored: ["Secret stored", "answered", "done"],
        withdrawn: ["Secret request withdrawn", "cancelled", "quiet"],
      }
    : {
        open: [e.type === "request.opened" ? "Approval asked" : "Approval asked again", "approval", "needs-you"],
        approved: ["Approved", "answered", "done"],
        denied: ["Denied", "denied", "quiet"],
        ran: ["Approved command ran", "answered", "done"],
        failed: ["Approved command failed", "failed", "failed"],
      };
  const [text, icon, tone] = words[state] ?? [secret ? "Secret request updated" : "Approval updated", secret ? "secret" : "approval", "quiet"];
  return { ...base, icon, tone, text, detail, run };
}

/** The lines of `events`, newest first, without repeats and without what the feed doesn't show. */
export const linesOf = (events: Iterable<HubEvent>): Line[] => {
  const bySeq = new Map<number, Line>();
  for (const e of events) {
    if (bySeq.has(e.seq)) continue;
    const line = describe(e);
    if (line !== undefined) bySeq.set(e.seq, line);
  }
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq);
};

/** A row of the feed. */
export type Row =
  | { readonly t: "day"; readonly key: string; readonly label: string }
  | { readonly t: "since"; readonly key: string }
  | { readonly t: "line"; readonly key: string; readonly line: Line; readonly child?: boolean }
  | { readonly t: "run"; readonly key: string; readonly label: string; readonly lines: readonly Line[]; readonly open: boolean };

/** One line, or a run of lines with one `run.key` side by side. */
export type Group = { readonly line: Line } | { readonly key: string; readonly label: string; readonly lines: readonly Line[] };

/**
 * Folds runs: lines next to each other (newest first) with the same run key become one group of two or more. A run
 * never spans a day or the "since you last looked" mark, so a folded row is always one day's and one side's.
 */
export function groups(lines: readonly Line[], nowMs: number, seenSeq?: number, timeZone?: string): Group[] {
  const out: Group[] = [];
  let i = 0;
  while (i < lines.length) {
    const first = lines[i];
    if (first === undefined) break;
    let j = i + 1;
    const run = first.run;
    if (run !== undefined) {
      const day = dayLabel(first.at, nowMs, timeZone);
      const side = seenSeq === undefined || first.seq > seenSeq;
      for (;;) {
        const next = lines[j];
        if (next?.run?.key !== run.key || dayLabel(next.at, nowMs, timeZone) !== day) break;
        if (seenSeq !== undefined && next.seq > seenSeq !== side) break;
        j++;
      }
    }
    const members = lines.slice(i, j);
    const oldest = members[members.length - 1];
    if (members.length > 1 && run !== undefined && oldest !== undefined) {
      // Keyed by its oldest line: a newer event joining the run keeps it open.
      out.push({ key: `${run.key}@${oldest.seq}`, label: run.label(members.length), lines: members });
    } else out.push({ line: first });
    i = j;
  }
  return out;
}

const newestOf = (g: Group): Line => ("line" in g ? g.line : (g.lines[0] as Line));

/**
 * The feed's rows: a day's name over its lines, the "since you last looked" divider above the first line the person
 * has seen (only when something newer is above it), and each run as one row, its lines under it when `open` has it.
 */
export function layout(
  lines: readonly Line[],
  opts: { readonly nowMs: number; readonly seenSeq?: number | undefined; readonly open?: ReadonlySet<string>; readonly timeZone?: string },
): Row[] {
  const { nowMs, seenSeq, timeZone } = opts;
  const rows: Row[] = [];
  let day: string | undefined;
  let newer = false;
  let marked = false;
  for (const g of groups(lines, nowMs, seenSeq, timeZone)) {
    const top = newestOf(g);
    if (seenSeq !== undefined && !marked) {
      if (top.seq > seenSeq) newer = true;
      else {
        marked = true;
        if (newer) rows.push({ t: "since", key: "since" });
      }
    }
    const label = dayLabel(top.at, nowMs, timeZone);
    if (label !== day) {
      day = label;
      rows.push({ t: "day", key: `day:${label}`, label });
    }
    if ("line" in g) {
      rows.push({ t: "line", key: `e${top.seq}`, line: top });
      continue;
    }
    const open = opts.open?.has(g.key) ?? false;
    rows.push({ t: "run", key: g.key, label: g.label, lines: g.lines, open });
    if (open) for (const line of g.lines) rows.push({ t: "line", key: `e${line.seq}`, line, child: true });
  }
  return rows;
}

/** How many lines are newer than `seenSeq`; none before the person has ever looked. */
export const unreadCount = (lines: readonly Line[], seenSeq: number | undefined): number =>
  seenSeq === undefined ? 0 : lines.filter((l) => l.seq > seenSeq).length;
