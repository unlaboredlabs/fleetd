// The lead digest: the code-rendered project state at the top of every wake. It is the lead's real memory, so it
// must stay small (DIGEST_MAX_TOKENS) and say plainly what was left out.
import type { Ask, CheckSpec, Decision, ProjectRef, Workstream, WorkstreamId } from "@fleetd/contracts";
import type { Answer } from "../ledger/Inbox.ts";

export const DIGEST_MAX_TOKENS = 1500;
/** Decisions listed by full value; the rest only appear by key under "do not re-ask". */
export const DIGEST_DECISIONS = 10;

/**
 * Conservative token estimate: ~3 characters per token. English prose runs nearer 4, but keys, ids and paths
 * tokenize worse, and overshooting the budget is the failure that matters.
 */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3);

export interface DigestInput {
  readonly project: { readonly ref: ProjectRef; readonly title: string };
  readonly at: string;
  /** Open workstreams, newest first. */
  readonly workstreams: ReadonlyArray<Workstream>;
  readonly openAsks: ReadonlyArray<Ask>;
  /** Asks the human answered or dropped since the lead's last wake. */
  readonly answers: ReadonlyArray<Answer>;
  /** Active decisions along the project's scope chain, any order. */
  readonly decisions: ReadonlyArray<Decision>;
  /** Lines from `taskDigestLines`; absent leaves the section out. */
  readonly tasks?: ReadonlyArray<string>;
  /** What fleetd itself measured per workstream; absent ones show none. */
  readonly facts?: ReadonlyMap<WorkstreamId, WorkstreamFacts>;
}

/** What backs a workstream's status beyond the lead's word: the checks its latest claim passed and its ETA. */
export interface WorkstreamFacts {
  /** Check indexes the latest finished claim passed. */
  readonly passed: ReadonlySet<number>;
  /** `etaText` of the calibrated estimate. */
  readonly eta?: string;
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export const describeCheck = (check: CheckSpec): string => {
  switch (check.type) {
    case "pr_merged":
      return `PR ${check.pr === undefined ? "" : `#${check.pr} `}merged in ${check.repo}`;
    case "ci_green":
      return `CI green on ${check.repo}${check.ref === undefined ? "" : `@${check.ref}`}`;
    case "http":
      return `GET ${check.url} → ${check.status}${check.contains === undefined ? "" : ` containing "${check.contains}"`}`;
    case "cmd":
      return `on ${check.machineId}: \`${check.argv.join(" ")}\` exits ${check.expectExit}`;
    case "test":
      return `test ${check.testId} passes in ${check.repo}`;
    case "judge":
      return `judge: ${check.criteria}`;
    case "human":
      return `human confirms: ${check.question}`;
  }
};

const scopeLabel = (d: Decision) => (d.scope.kind === "workstream" ? d.scope.workstreamId : d.scope.kind);

/** Open workstreams' own decisions first, then the project's, then global ones; newest first within each. */
export const rankDecisions = (decisions: ReadonlyArray<Decision>, open: ReadonlySet<WorkstreamId>): ReadonlyArray<Decision> => {
  const rank = (d: Decision) =>
    d.scope.kind === "workstream" ? (open.has(d.scope.workstreamId) ? 0 : 3) : d.scope.kind === "project" ? 1 : 2;
  return [...decisions].sort((a, b) => rank(a) - rank(b) || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
};

/** The done-when list as `done:<n>`, the index `--serves` and claims use; ✓ only where fleetd's own check passed. */
export const doneWhenText = (checks: ReadonlyArray<CheckSpec>, passed: ReadonlySet<number> = new Set(), max = 120) =>
  checks.map((c, i) => `done:${i}${passed.has(i) ? " ✓" : ""} ${oneLine(describeCheck(c), max)}`).join("; ");

const workstreamLines = (w: Workstream, facts: WorkstreamFacts | undefined) => {
  const head = `- ${w.workstreamId} ${w.state}: ${oneLine(w.title, 120)}`;
  if (w.brief === undefined) {
    return `${head}\n  no brief yet: register it with \`fleetd brief create --workstream ${w.workstreamId} --json '<Brief>'\``;
  }
  const status = w.headline === undefined ? "" : `\n  lead says: ${oneLine(w.headline, 200)}`;
  const eta = facts?.eta === undefined ? "" : `\n  ${facts.eta}`;
  return `${head}${status}\n  done when: ${doneWhenText(w.brief.doneWhen, facts?.passed)}${eta}`;
};

const askLine = (a: Ask) => {
  const where = a.batchId === undefined ? "not batched yet" : `#${a.number} in ${a.batchId}`;
  const rec = a.recommendation === undefined ? "" : `; rec ${oneLine(a.recommendation, 80)}`;
  const proceeded = a.proceededOnRec ? "; you proceeded on the rec" : "";
  return `- ${a.askId} (${where}) [${a.class}] ${a.key}: ${oneLine(a.text, 200)}${rec}${proceeded}`;
};

const answerLine = ({ ask, outcome, value, decision }: Answer) =>
  outcome === "withdrawn"
    ? `- ${ask.askId} ${ask.key}: dropped by the human; do not pursue it`
    : `- ${ask.askId} ${ask.key} → ${oneLine(value ?? decision?.value ?? "", 300)}${decision === undefined ? "" : ` (${decision.decisionId})`}`;

const decisionLine = (d: Decision) => `- ${d.decisionId} ${d.key} = ${oneLine(d.value, 200)} (${scopeLabel(d)}, ${d.source})`;

interface Section {
  readonly title: string;
  readonly items: Array<string>;
  /** Items left out, on top of any trimmed to fit. */
  omitted: number;
  readonly more: string;
  readonly join: string;
}

const renderSection = (s: Section) => {
  const body = s.items.length === 0 && s.omitted === 0 ? "none" : s.items.join(s.join);
  const more = s.omitted === 0 ? "" : `${s.items.length === 0 ? "" : s.join}(+${s.omitted} more: ${s.more})`;
  return `## ${s.title}\n${body}${more}`;
};

const capped = (items: ReadonlyArray<string>, max: number) => ({ items: items.slice(0, max), omitted: Math.max(0, items.length - max) });

export const renderLeadDigest = (input: DigestInput): string => {
  const { ref, title } = input.project;
  const open = new Set(input.workstreams.map((w) => w.workstreamId));
  const ranked = rankDecisions(input.decisions, open);
  const keys = [...new Set([...ranked.map((d) => d.key), ...input.openAsks.map((a) => a.key)])];

  const header = [
    `# fleetd digest: project ${oneLine(title, 80)} (${ref.machineId}/${ref.projectId}), ${input.at}`,
    "This is the current truth about your project. Trust it over your memory.",
  ].join("\n");

  const answers: Section = { title: "Answers since your last wake", ...capped(input.answers.map(answerLine), 20), more: "see `fleetd decisions search`", join: "\n" };
  const workstreams: Section = { title: "Open workstreams", ...capped(input.workstreams.map((w) => workstreamLines(w, input.facts?.get(w.workstreamId))), 20), more: "older ones not shown", join: "\n" };
  const tasks: Section = { title: "Tasks", ...capped(input.tasks ?? [], 20), more: "`fleetd task list`", join: "\n" };
  const asks: Section = { title: "Your open asks", ...capped(input.openAsks.map(askLine), 20), more: "older ones not shown", join: "\n" };
  const decisions: Section = {
    title: "Decisions (most relevant)",
    ...capped(ranked.map(decisionLine), DIGEST_DECISIONS),
    more: "`fleetd decisions search \"<q>\"`",
    join: "\n",
  };
  const doNotReAsk: Section = { title: "Do not re-ask: keys already decided or asked", ...capped(keys, 200), more: "check with `fleetd decisions search`", join: ", " };

  const order = [answers, workstreams, ...(input.tasks === undefined ? [] : [tasks]), asks, decisions, doNotReAsk];
  const render = () => [header, ...order.map(renderSection)].join("\n\n");
  // Lowest value first: the key list, then decisions, asks, workstreams, and answers last. The first pass keeps a
  // few of each so no section vanishes while another is long; the second trims to nothing if it must.
  const dropOrder: ReadonlyArray<readonly [Section, number]> = [
    [doNotReAsk, 30],
    [decisions, 3],
    [asks, 5],
    [tasks, 5],
    [workstreams, 5],
    [answers, 5],
  ];
  let text = render();
  for (const pass of [1, 0]) {
    for (const [section, floor] of dropOrder) {
      while (estimateTokens(text) > DIGEST_MAX_TOKENS && section.items.length > floor * pass) {
        section.items.pop();
        section.omitted += 1;
        text = render();
      }
    }
  }
  return text;
};
