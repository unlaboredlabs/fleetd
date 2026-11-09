// The lead digest: the code-rendered project state at the top of a lead's
// first message and every wake (the event lines follow it, `events`). It is the lead's real memory, so it stays small
// (DIGEST_MAX_CHARS) and says plainly what was left out. A fixed format, not a prompt.
import type { Decision, HumanRequest, ProjectRef, Workstream, WorkstreamState } from "../../shared/contracts.ts";
import { type AgentsLine, agentsFree, agentsLineText } from "./events.ts";
import { oneLine } from "./text.ts";

export { clip, oneLine } from "./text.ts";

/** About 1,500 tokens: ids, keys and paths run near 3 characters a token. */
export const DIGEST_MAX_CHARS = 4500;
/** Free slots this long with no agent starting or ending while approved work is open earn the idle line. */
export const IDLE_SLOTS_MINUTES = 10;
/** Decisions listed by full value; the rest only appear by key under "do not re-ask". */
export const DIGEST_DECISIONS = 10;
/** The Elsewhere section's "more" words (work/elsewhere.rs `CUT_FIRST`). */
const ELSEWHERE_CUT_FIRST = "expired claims, then landings, are cut first";

/** What backs a workstream's status beyond the lead's word: the human's latest direct steers to its tasks. */
export type WorkstreamFacts = { steers?: string };

export type DigestInput = {
  projectRef: ProjectRef;
  title: string;
  at: string;
  /** Open workstreams, newest first. */
  workstreams: Workstream[];
  /** The project's open secret and approval requests: what waits on the person in chat. */
  openRequests: HumanRequest[];
  /** Active decisions along the project's scope chain, any order. */
  decisions: Decision[];
  agents?: AgentsLine;
  /** The idle line under it, once per idle stretch. */
  idle?: string;
  /** The usage layer's pause on the project's machine ("usage: paused until …"). */
  usage?: string;
  /** Lines from the tasks area; undefined leaves the section out. */
  tasks?: string[];
  train?: string[];
  elsewhere?: string[];
  checklist?: string[];
  facts: Map<string, WorkstreamFacts>;
};

/** The pause, when it ends, and who can lift it. */
export function usageLine(machine: string, paused: string): string {
  const why = paused.startsWith("usage: ") ? paused.slice(7) : paused;
  return `Usage pause on ${machine}: ${why}. Its parked agents go on by themselves when it ends. The human can press Resume in the app or run \`fleetd usage resume ${machine}\`; once you know the login has capacity again, \`usage_resume\` lifts it (once per 10 min).`;
}

/**
 * One plain line when the project's free slots have sat idle a while and approved work could take more agents;
 * undefined otherwise.
 */
export function idleLine(agents: AgentsLine, workstreams: Workstream[], openRequests: HumanRequest[], paused: boolean): string | undefined {
  const [free, minutes] = [agentsFree(agents), agents.idleMinutes];
  const waiting = (w: Workstream) => openRequests.some((r) => r.workstreamId === w.workstreamId);
  const approved = workstreams.filter((w) => w.brief !== undefined && !waiting(w)).length;
  if (paused || free === 0 || minutes < IDLE_SLOTS_MINUTES || approved === 0) return undefined;
  const slots = free === 1 ? "slot has" : "slots have";
  const orders = approved === 1 ? "1 approved order is" : `${approved} approved orders are`;
  return `Idle: ${free} ${slots} sat free for ${minutes} min while ${orders} open. Split the work into parts that touch different files and spawn them now; sequence only parts that share code.`;
}

function scopeLabel(d: Decision): string {
  if (d.scope.kind === "workstream") return d.scope.workstreamId;
  return d.scope.kind === "project" ? "project" : "global";
}

/** Open workstreams' own decisions first, then the project's, then global ones; newest first within each. */
export function rankDecisions(decisions: Decision[], open: Set<string>): Decision[] {
  const rank = (d: Decision) => (d.scope.kind === "workstream" ? (open.has(d.scope.workstreamId) ? 0 : 3) : d.scope.kind === "project" ? 1 : 2);
  return [...decisions].sort((a, b) => rank(a) - rank(b) || (b.at < a.at ? -1 : b.at > a.at ? 1 : 0));
}

/** The done-when lines as `done:<n> <line>`. */
export const doneWhenText = (lines: string[], max: number) => lines.map((line, i) => `done:${i} ${oneLine(line, max)}`).join("; ");

export const stateText = (state: WorkstreamState) => state;

function workstreamLines(w: Workstream, facts: WorkstreamFacts | undefined): string {
  const head = `- ${w.workstreamId} ${stateText(w.state)}: ${oneLine(w.title, 120)}`;
  if (!w.brief) return `${head}\n  no brief yet: register it with \`brief\` {workstreamId: "${w.workstreamId}"}`;
  const steers = facts?.steers === undefined ? "" : `\n  steers: ${facts.steers}`;
  return `${head}\n  done when: ${doneWhenText(w.brief.doneWhen, 120)}${steers}`;
}

function requestLine(r: HumanRequest): string {
  const what = r.secret
    ? `secret ${r.secret.key} to enter`
    : r.gated
      ? `approve your command: ${oneLine(r.gated.reason, 120)}`
      : r.permission
        ? `approve a tool prompt: ${r.permission.toolName} ${oneLine(r.permission.summary, 120)}`
        : oneLine(r.text, 120);
  const again = r.evidence === undefined ? "" : ` (open again: ${oneLine(r.evidence, 160)})`;
  return `- ${r.requestId} ${what}${again}`;
}

const decisionLine = (d: Decision) => `- ${d.decisionId} ${d.key} = ${oneLine(d.value, 200)} (${scopeLabel(d)}, ${d.source})`;

type Section = { title: string; items: string[]; omitted: number; more: string; join: string };

function section(title: string, items: string[], max: number, more: string, join: string): Section {
  return { title, items: items.slice(0, max), omitted: Math.max(items.length - max, 0), more, join };
}

function renderSection(s: Section): string {
  const body = s.items.length === 0 && s.omitted === 0 ? "none" : s.items.join(s.join);
  const more = s.omitted === 0 ? "" : `${s.items.length === 0 ? "" : s.join}(+${s.omitted} more: ${s.more})`;
  return `## ${s.title}\n${body}${more}`;
}

const WORKSTREAMS = 0;
const TASKS = 1;
const TRAIN = 2;
const ELSEWHERE = 3;
const REQUESTS = 4;
const DECISIONS = 5;
const DO_NOT_RE_ASK = 6;
const CHECKLIST = 7;

const chars = (s: string) => [...s].length;

export function renderLeadDigest(input: DigestInput): string {
  const open = new Set(input.workstreams.map((w) => w.workstreamId));
  const ranked = rankDecisions(input.decisions, open);
  const keys: string[] = [];
  for (const d of ranked) if (!keys.includes(d.key)) keys.push(d.key);
  let head = `# project ${oneLine(input.title, 80)} (${input.projectRef.machineId}/${input.projectRef.projectId}), ${input.at}`;
  if (input.agents) head += `\n${agentsLineText(input.agents)}`;
  if (input.idle !== undefined) head += `\n${input.idle}`;
  if (input.usage !== undefined) head += `\n${usageLine(input.projectRef.machineId, input.usage)}`;
  const sections: Section[] = [
    section("Work", input.workstreams.map((w) => workstreamLines(w, input.facts.get(w.workstreamId))), 20, "older ones not shown", "\n"),
    section("Agents", input.tasks ?? [], 20, "`agents`", "\n"),
    section("Merge train", input.train ?? [], 12, "older ones not shown", "\n"),
    section("Elsewhere", input.elsewhere ?? [], 8, ELSEWHERE_CUT_FIRST, "\n"),
    section("Waiting on the person (in chat)", input.openRequests.map(requestLine), 20, "older ones not shown", "\n"),
    section("Decisions", ranked.map(decisionLine), DIGEST_DECISIONS, "`decisions_search`", "\n"),
    section("Decided already: never ask again", keys, 200, "check with `decisions_search`", ", "),
    section("Checklist", input.checklist ?? [], 20, "the rest of the list", "\n"),
  ];
  const shown = [WORKSTREAMS];
  if (input.checklist) shown.push(CHECKLIST);
  if (input.tasks) shown.push(TASKS);
  if (input.train) shown.push(TRAIN);
  if (input.elsewhere) shown.push(ELSEWHERE);
  shown.push(REQUESTS, DECISIONS, DO_NOT_RE_ASK);
  // An empty section says nothing a wake needs, except that there is no work.
  const render = () =>
    `${head}\n\n${shown
      .filter((i) => i === WORKSTREAMS || (sections[i] as Section).items.length > 0 || (sections[i] as Section).omitted > 0)
      .map((i) => renderSection(sections[i] as Section))
      .join("\n\n")}`;
  // Lowest value first; the first pass keeps a few of each so no section vanishes while another is long.
  const dropOrder: [number, number][] = [
    [DO_NOT_RE_ASK, 30],
    [DECISIONS, 3],
    [ELSEWHERE, 3],
    [REQUESTS, 5],
    [TASKS, 5],
    [TRAIN, 4],
    [CHECKLIST, 4],
    [WORKSTREAMS, 5],
  ];
  let text = render();
  for (const pass of [1, 0]) {
    for (const [i, floor] of dropOrder) {
      const s = sections[i] as Section;
      while (chars(text) > DIGEST_MAX_CHARS && s.items.length > floor * pass) {
        s.items.pop();
        s.omitted += 1;
        text = render();
      }
    }
  }
  return text;
}
