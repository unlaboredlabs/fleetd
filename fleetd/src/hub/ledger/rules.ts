// The decision log's rules and words, with no database behind them (repo.ts writes the rows, decisions.ts and
// tools.ts answer the calls): ids, scopes, the search's words, the events, and what the tools say.
import type {
  Decision,
  DecisionKey,
  DecisionScope,
  DecisionSource,
  DecisionState,
  PersonRef,
  ProjectRef,
  WorkstreamId,
} from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { quote } from "../../shared/text.ts";
import type { NewEvent } from "../store/new_event.ts";

const MAX_SAFE_INT = 9007199254740991;

/** Who is writing: filled by the hub from the caller (human device, agent key or lead-side call). */
export type Actor = {
  source: DecisionSource;
  /** "human:<device>", the agent key name, or "lead:<machineId>/<projectId>". */
  by: string;
  /** A human key's person. */
  person?: PersonRef;
};

/** Where a lookup starts: the workstream (when known), then its project, then global. */
export type Chain = { projectRef: ProjectRef; workstreamId?: string };

/** Stable text form of a project ref; machine ids cannot contain "/". */
export const projectKey = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;

/** `D12` → 12; undefined for anything that isn't a decision id. */
export function decisionN(id: string): number | undefined {
  if (!/^D\d+$/.test(id)) return undefined;
  const n = Number(id.slice(1));
  return n > 0 && n <= MAX_SAFE_INT ? n : undefined;
}

const STOPWORDS = ["the", "and", "for", "should", "what", "which", "use", "with", "this", "that", "we", "do"];

/** The words of `text` a search matches on, once each, in order: none shorter than 2 or a stop word, 24 at most. */
export function searchWords(text: string): string[] {
  const words: string[] = [];
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word !== "" && !words.includes(word)) words.push(word);
  }
  return words.filter((w) => w.length >= 2 && !STOPWORDS.includes(w)).slice(0, 24);
}

/** FTS5 query matching any of the words in `text`; undefined when there are none worth matching. */
export function ftsQuery(text: string): string | undefined {
  const kept = searchWords(text).map((w) => `"${w}"`);
  return kept.length > 0 ? kept.join(" OR ") : undefined;
}

export function scopeColumns(scope: DecisionScope): [kind: string, id: string] {
  switch (scope.kind) {
    case "global":
      return ["global", ""];
    case "project":
      return ["project", projectKey(scope.projectRef)];
    case "workstream":
      return ["workstream", scope.workstreamId];
  }
}

export const decisionStateText = (state: DecisionState) => state;

export type RecordInput = {
  key: DecisionKey;
  scope: DecisionScope;
  value: string;
  why?: string;
  /** The project a workstream-scoped decision belongs to, so project-wide lookups find it. */
  projectRef?: ProjectRef;
};

export type DecisionFilter = {
  /** Global decisions plus everything recorded in this project. */
  chain?: Chain;
  /** Exactly this scope. */
  scope?: DecisionScope;
  source?: DecisionSource;
  /** Recorded at or after this time (ms). */
  sinceMs?: number;
  limit?: number;
};

/** An event's machine and project, for decisions that have one. */
const projectFields = (r: ProjectRef | undefined) => (r ? { machineId: r.machineId, projectId: r.projectId } : {});

/** The `decision.recorded` event; `project` names the project of a workstream-scoped decision. */
export function recordedEvent(decision: Decision, project: ProjectRef | undefined): NewEvent {
  const projectRef = decision.scope.kind === "project" ? decision.scope.projectRef : project;
  const data: Record<string, unknown> = {
    decisionId: decision.decisionId,
    key: decision.key,
    scope: decision.scope,
    source: decision.source,
  };
  if (decision.supersedes !== undefined) data.supersedes = decision.supersedes;
  return {
    at: decision.at,
    type: "decision.recorded",
    ...projectFields(projectRef),
    summary: `${decision.decisionId} ${decision.key} = ${decision.value}`,
    data,
  };
}

/** The `decision.retired` event: a person revoked the decision, and its key goes unanswered again. */
export function retiredEvent(decision: Decision, project: ProjectRef | undefined): NewEvent {
  return {
    at: decision.retired?.at ?? decision.at,
    type: "decision.retired",
    ...projectFields(project),
    summary: `${decision.decisionId} ${decision.key} revoked`,
    data: { decisionId: decision.decisionId, key: decision.key, scope: decision.scope },
  };
}

export const SEARCH_LIMIT = 20;

export const unknownWorkstream = (id: WorkstreamId) => new ToolError("not_found", `No workstream ${id}.`, "Call workstream_list to see workstreams.");

export const GLOBAL_REFUSED = "A global decision applies to every machine; this key has no operate grant on all of them.";

/** decisions_search's `next` when nothing matched. */
export const NO_MATCH = "No active decision matches; record one with decisions_record.";

/** decisions_record's `next`. */
export function recordedNext(decision: Decision): string {
  const supersedes = decision.supersedes ? ` and supersedes ${decision.supersedes}` : "";
  return `${decision.decisionId} is active${supersedes}. Leads use it instead of asking; a project's lead is woken with it.`;
}

/** An overturn of a decision no longer active. */
export const notActive = (decisionId: string, state: DecisionState) =>
  new ToolError("invalid", `${decisionId} is already ${state}.`, "Overturn the decision that answers its key now.");

/** The project's lead's line for a person's overturn of `old`, asked for as `id`, `why`: replaced by `replacement`, or revoked. */
export const overturnLine = (id: string, old: Decision, why: string, replacement: Decision | undefined) =>
  replacement
    ? `- the human replaced ${id} ${old.key} ${quote(old.value)} with ${replacement.decisionId} ${quote(replacement.value)}: ${quote(why)}; follow ${replacement.decisionId} from now on`
    : `- the human revoked ${id} ${old.key} (was ${quote(old.value)}): ${quote(why)}; it is open again, so ask before deciding it`;

/** decisions_overturn's `next`. */
export const overturnedNext = (old: Decision, replacement: Decision | undefined) =>
  replacement ? `${replacement.decisionId} answers ${replacement.key} now; the lead reads it at its next wake.` : `${old.key} is unanswered again; the lead asks before deciding it.`;
