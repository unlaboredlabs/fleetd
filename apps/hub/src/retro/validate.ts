// Checking the retro's answer. The model says whether a change is wording or a gate; the hub decides by the fields
// the diff actually changes, so a gate change cannot pass as wording. Pure.
import { PlaybookChange, PlaybookName, RetroMetricClass, type PlaybookChangeKind } from "@fleetd/contracts";
import * as Schema from "effect/Schema";
import { parsePlaybook } from "../playbooks/load.ts";
import { applyUnifiedDiff } from "./diff.ts";

/** The only fields a wording change may touch. Every other frontmatter field is a gate, including any added later. */
export const WORDING_FIELDS: ReadonlySet<string> = new Set(["leadInstructions", "estimatePrior"]);

/** At most this many changes are read from one answer. */
export const MAX_CHANGES = 10;

export interface Accepted {
  readonly change: PlaybookChange;
  readonly kind: PlaybookChangeKind;
  /** Frontmatter fields it changes, plus "body". */
  readonly fields: ReadonlyArray<string>;
  /** The playbook file after the diff. */
  readonly after: string;
}

export interface Dropped {
  readonly index: number;
  readonly playbook?: string;
  readonly reason: string;
}

export interface Context {
  readonly windowDays: number;
  /** Incident ids in the run's window. */
  readonly incidents: ReadonlySet<string>;
  /** Each playbook's current file text. */
  readonly playbooks: ReadonlyMap<PlaybookName, string>;
  /** Playbooks that may not change now, with why (a change still being measured, a gate ask still open). */
  readonly busy: ReadonlyMap<string, string>;
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u;
const bodyOf = (text: string) => text.slice(FRONTMATTER.exec(text)?.[0].length ?? 0);

const decodeChange = Schema.decodeUnknownExit(PlaybookChange);
const isName = Schema.is(PlaybookName);
const isMetric = Schema.is(RetroMetricClass);

const schemaReason = (exit: ReturnType<typeof decodeChange>) => {
  if (exit._tag === "Success") return "";
  const error = exit.cause.reasons.find((r) => r._tag === "Fail")?.error;
  return (error instanceof Error ? error.message : "it does not match the PlaybookChange shape").replace(/\s+/gu, " ").slice(0, 300);
};

/** Frontmatter fields whose values differ, plus "body" when the text below the frontmatter does. */
export const changedFields = (before: string, after: string, where: string): ReadonlyArray<string> => {
  const a = parsePlaybook(before, where).playbook as Record<string, unknown>;
  const b = parsePlaybook(after, where).playbook as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const fields = keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  return bodyOf(before).trim() === bodyOf(after).trim() ? fields : [...fields, "body"];
};

/** One proposed change, checked against the run's window and the current playbooks. */
export const checkChange = (raw: unknown, ctx: Context, taken: ReadonlySet<string>): Accepted | string => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "it is not a JSON object";
  const item = raw as { readonly playbook?: unknown; readonly metric?: { readonly class?: unknown } };
  if (!isName(item.playbook)) return `"${String(item.playbook)}" is not a playbook (${PlaybookName.literals.join(", ")})`;
  const metricClass = item.metric?.class;
  if (!isMetric(metricClass)) return `"${String(metricClass)}" is not a metric fleetd measures (${RetroMetricClass.literals.join(", ")})`;
  const decoded = decodeChange(raw);
  if (decoded._tag === "Failure") return `it does not match the change shape: ${schemaReason(decoded)}`;
  const change = decoded.value;
  if (change.fixesIncidents.length === 0) return "it cites no incident it fixes";
  const unknown = change.fixesIncidents.filter((id) => !ctx.incidents.has(id));
  if (unknown.length > 0) return `it cites ${unknown.join(", ")}, not incidents of the last ${ctx.windowDays} days`;
  const busy = ctx.busy.get(change.playbook);
  if (busy !== undefined) return busy;
  if (taken.has(change.playbook)) return `a second change to ${change.playbook} in one run`;
  const before = ctx.playbooks.get(change.playbook)!;
  const patched = applyUnifiedDiff(before, change.diff);
  if ("error" in patched) return patched.error;
  let fields: ReadonlyArray<string>;
  try {
    parsePlaybook(patched.text, `${change.playbook}.md after the diff`, change.playbook);
    fields = changedFields(before, patched.text, change.playbook);
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 300);
  }
  if (fields.length === 0) return "the diff changes nothing";
  const kind: PlaybookChangeKind = fields.some((f) => f !== "body" && !WORDING_FIELDS.has(f)) ? "gate" : "wording";
  if (kind === "wording" && fields.includes("body")) {
    return `a wording change may touch only ${[...WORDING_FIELDS].join(" and ")}; this one also changes the body`;
  }
  return { change, kind, fields, after: patched.text };
};

/** The model's answer text: `{"changes": [...]}`, possibly wrapped in prose or a code fence. */
export const validateAnswer = (
  text: string,
  ctx: Context,
): { readonly accepted: ReadonlyArray<Accepted>; readonly dropped: ReadonlyArray<Dropped> } | { readonly error: string } => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return { error: "the answer has no JSON object" };
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { error: "the answer is not valid JSON" };
  }
  const changes = typeof raw === "object" && raw !== null && "changes" in raw ? raw.changes : undefined;
  if (!Array.isArray(changes)) return { error: 'the answer has no "changes" list' };
  const accepted: Array<Accepted> = [];
  const dropped: Array<Dropped> = [];
  const taken = new Set<string>();
  for (const [index, item] of changes.entries()) {
    const playbook = typeof item?.playbook === "string" ? { playbook: item.playbook as string } : {};
    if (index >= MAX_CHANGES) {
      dropped.push({ index, ...playbook, reason: `more than ${MAX_CHANGES} changes in one answer` });
      continue;
    }
    const checked = checkChange(item, ctx, taken);
    if (typeof checked === "string") dropped.push({ index, ...playbook, reason: checked });
    else {
      taken.add(checked.change.playbook);
      accepted.push(checked);
    }
  }
  return { accepted, dropped };
};
