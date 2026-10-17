// The lead digest: the code-rendered project state at the top of every wake. It is the lead's real memory, so it
// must stay small (DIGEST_MAX_TOKENS) and say plainly what was left out.
import type { Ask, CheckSpec, Decision, ProjectRef, Workstream, WorkstreamId } from "@fleetd/contracts";

export const DIGEST_MAX_TOKENS = 1500;
/** Decisions listed by full value; the rest only appear by key under "do not re-ask". */
export const DIGEST_DECISIONS = 10;

/**
 * Conservative token estimate: ~3 characters per token. English prose runs nearer 4, but keys, ids and paths
 * tokenize worse, and overshooting the budget is the failure that matters.
 */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3);

/** An ask the human answered or dropped since the lead's last wake. */
export interface AnswerNote {
  readonly ask: Ask;
  /** Absent when the human dropped the ask instead of answering it. */
  readonly decision?: Decision;
}

export interface DigestInput {
  readonly project: { readonly ref: ProjectRef; readonly title: string };
  readonly at: string;
  /** Open workstreams, newest first. */
  readonly workstreams: ReadonlyArray<Workstream>;
  readonly openAsks: ReadonlyArray<Ask>;
  readonly answers: ReadonlyArray<AnswerNote>;
  /** Active decisions along the project's scope chain, any order. */
  readonly decisions: ReadonlyArray<Decision>;
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

const workstreamLines = (w: Workstream) => {
  const head = `- ${w.workstreamId} ${w.state}: ${oneLine(w.title, 120)}`;
  if (w.brief === undefined) {
    return `${head}\n  no brief yet: register it with \`fleetd brief create --workstream ${w.workstreamId} --json '<Brief>'\``;
  }
  const status = w.headline === undefined ? "" : `\n  status: ${oneLine(w.headline, 200)}`;
  const done = w.brief.doneWhen.map((c, i) => `${i + 1}) ${oneLine(describeCheck(c), 120)}`).join("; ");
  return `${head}${status}\n  done when: ${done}`;
};

const askLine = (a: Ask) => {
  const where = a.batchId === undefined ? "not batched yet" : `#${a.number} in ${a.batchId}`;
  const rec = a.recommendation === undefined ? "" : `; rec ${oneLine(a.recommendation, 80)}`;
  const proceeded = a.proceededOnRec ? "; you proceeded on the rec" : "";
  return `- ${a.askId} (${where}) [${a.class}] ${a.key}: ${oneLine(a.text, 200)}${rec}${proceeded}`;
};

const answerLine = ({ ask, decision }: AnswerNote) =>
  decision === undefined
    ? `- ${ask.askId} ${ask.key}: dropped by the human; do not pursue it`
    : `- ${ask.askId} ${ask.key} → ${oneLine(decision.value, 300)} (${decision.decisionId})`;

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
  const workstreams: Section = { title: "Open workstreams", ...capped(input.workstreams.map(workstreamLines), 20), more: "older ones not shown", join: "\n" };
  const asks: Section = { title: "Your open asks", ...capped(input.openAsks.map(askLine), 20), more: "older ones not shown", join: "\n" };
  const decisions: Section = {
    title: "Decisions (most relevant)",
    ...capped(ranked.map(decisionLine), DIGEST_DECISIONS),
    more: "`fleetd decisions search \"<q>\"`",
    join: "\n",
  };
  const doNotReAsk: Section = { title: "Do not re-ask: keys already decided or asked", ...capped(keys, 200), more: "check with `fleetd decisions search`", join: ", " };

  const order = [answers, workstreams, asks, decisions, doNotReAsk];
  const render = () => [header, ...order.map(renderSection)].join("\n\n");
  // Lowest value first: the key list, then decisions, asks, workstreams, and answers last. The first pass keeps a
  // few of each so no section vanishes while another is long; the second trims to nothing if it must.
  const dropOrder: ReadonlyArray<readonly [Section, number]> = [
    [doNotReAsk, 30],
    [decisions, 3],
    [asks, 5],
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
