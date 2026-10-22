// What the hover cards say: the exact command, duration, exit code and output size of a span, the shares of a
// merged bar, a lane's totals and gaps, or a step of the critical path. Plain data; the timeline lays it out.
import {
  CAT_LABEL,
  KIND_WORD,
  ROLE_WORD,
  WHY,
  clockMs,
  fmtBytes,
  fmtDur,
  gapWord,
  inexact,
  markedDur,
  spanTitle,
  titleIsMachineText,
  type Names,
} from "./format";
import { humanizeKey } from "../../ui";
import { fmtTokens, shortModel } from "../live/format";
import { bucketShares, catLabel, type Bar, type Model } from "./model";

export interface Card {
  readonly title: string;
  /** The title is a command, path or check name: set in mono. */
  readonly mono: boolean;
  /** The category word beside the title. */
  readonly tag?: string;
  /** Quiet one-line facts, in order. */
  readonly lines: readonly string[];
  /** Lines in the warning colour: missing data. */
  readonly warnings?: readonly string[];
  readonly onPath?: boolean;
  /** Why a figure isn't exact, in a sentence. */
  readonly note?: string;
  /** What a click does. */
  readonly hint: string;
  /** "Nothing running" on the path. */
  readonly danger?: boolean;
}

const DECIDED: Record<string, string> = {
  policy: "the machine's policy, at once",
  hub_rule: "a project tool rule",
  lead: "the lead",
};

export const barCard = (m: Model, row: number, bar: Bar, names: Names, nowMs: number): Card => {
  const r = m.rows[row];
  if (bar.n > 1) {
    const { total, share } = bucketShares(m, bar);
    return {
      title: `${bar.n} spans, mostly ${catLabel(bar.cat)} (${share}%)`,
      mono: false,
      lines: [`${fmtDur(total)} · ${clockMs(bar.start)} to ${clockMs(bar.end)}`],
      note: "Too short to draw one by one at this zoom.",
      hint: "Click to zoom in.",
    };
  }
  const span = m.spans[m.itemSpan[bar.first] ?? -1];
  if (span === undefined || r === undefined) return { title: "", mono: false, lines: [], hint: "" };
  const parallel = m.parallel.has(span.id);
  const end = span.endMs;
  const mark = inexact(span, names, parallel);
  const facts = [r.name, markedDur((end ?? nowMs) - span.startMs, mark?.mark)];
  if (span.exitCode !== undefined) facts.push(`exit ${span.exitCode}`);
  if (span.outBytes !== undefined) facts.push(`${fmtBytes(span.outBytes)} output`);
  if (span.status === "failed" && span.exitCode === undefined) facts.push("failed");
  if (span.status === "cancelled") facts.push("cancelled");
  if (span.status === "incomplete") facts.push("cut short");
  const lines = [facts.join(" · "), end === undefined ? `since ${clockMs(span.startMs)}, still running` : `${clockMs(span.startMs)} to ${clockMs(end)}`];
  const parent = span.parent === undefined ? undefined : m.spans[m.byId.get(span.parent) ?? -1];
  if (parent?.kind === "model.message") {
    const phases = (m.children.get(parent.id) ?? []).map((c) => {
      const s = m.spans[c];
      return s === undefined ? "" : `${KIND_WORD[s.kind]} ${fmtDur((s.endMs ?? nowMs) - s.startMs)}`;
    });
    lines.push(`message ${fmtDur((parent.endMs ?? nowMs) - parent.startMs)} · ${phases.join(" · ")}`);
    const x = parent.extra;
    const tok = [
      ...(x?.outputTokens === undefined ? [] : [`${x.outputTokens} output tokens`]),
      ...(x?.thinkingTokens === undefined ? [] : [`${x.thinkingTokens} thinking (exact)`]),
      ...(x?.stopReason === undefined ? [] : [`stopped: ${x.stopReason}`]),
    ];
    if (tok.length > 0) lines.push(tok.join(" · "));
  }
  if (span.kind === "tools.parallel") {
    const kids = m.children.get(span.id) ?? [];
    lines.push(`${kids.length} calls at once; the group's time is exact`);
    for (const c of kids.slice(0, 6)) {
      const s = m.spans[c];
      if (s !== undefined) lines.push(`≤ ${fmtDur((s.endMs ?? nowMs) - s.startMs)}  ${spanTitle(s, humanizeKey)}`);
    }
  }
  const x = span.extra;
  if (x?.decidedBy !== undefined) {
    lines.push(`answered by ${x.decidedBy === "human" ? (x.answeredBy === undefined ? "you" : `you (${x.answeredBy})`) : (DECIDED[x.decidedBy] ?? x.decidedBy)}`);
  }
  if (x?.httpStatus !== undefined) {
    lines.push(`retried on HTTP ${x.httpStatus}${x.statedDelayMs === undefined ? "" : ` · claude said wait ${fmtDur(x.statedDelayMs)}`}`);
  }
  if (x?.reason !== undefined && x.reason !== "") lines.push(x.reason);
  if (x?.claudeMs !== undefined) lines.push(`claude's own figure: ${fmtDur(x.claudeMs)}`);
  const hint =
    x?.url !== undefined
      ? "Click to open the check on GitHub."
      : span.itemId !== undefined && span.threadId !== undefined
        ? "Click to open the transcript."
        : "Click to zoom to it.";
  return {
    title: spanTitle(span, humanizeKey),
    mono: titleIsMachineText(span),
    tag: CAT_LABEL[span.cat],
    lines,
    onPath: bar.onPath,
    ...(mark === undefined ? {} : { note: mark.why }),
    hint,
  };
};

/** `tokens`: the lane's live input and output while it runs, else its measured output (`Row.outputTokens`). */
export const laneCard = (m: Model, row: number, tokens: number): Card => {
  const r = m.rows[row];
  if (r === undefined) return { title: "", mono: false, lines: [], hint: "" };
  const title = r.kind === "lead" ? "The project's lead" : r.role !== undefined && r.kind !== "other" ? `${ROLE_WORD[r.role]}: ${r.name}` : r.name;
  const lines = [`${r.to - r.from} spans · ${fmtDur(r.agentMs)} of agent time`];
  const who = [r.model === undefined ? undefined : shortModel(r.model), tokens > 0 ? `${fmtTokens(tokens)} tokens` : undefined].filter((x) => x !== undefined);
  if (who.length > 0) lines.push(who.join(" · "));
  if (r.summary !== "") lines.push(r.summary);
  const warnings = r.gaps.slice(0, 4).map(([a, b, why]) => `${gapWord(why)} ${clockMs(a)} to ${clockMs(b)}`);
  return {
    title,
    mono: r.kind === "check",
    lines,
    warnings,
    ...(r.kind === "lead" ? { note: `${WHY.lead} This lane shows this work's share.` } : {}),
    hint: r.to > r.from ? "Click to zoom to this lane." : "No spans to zoom to.",
  };
};

export const pathCard = (m: Model, seg: number): Card => {
  const s = m.path[seg];
  if (s === undefined) return { title: "", mono: false, lines: [], hint: "" };
  const when = `${fmtDur(s.end - s.start)} · ${clockMs(s.start)} to ${clockMs(s.end)}`;
  if (s.span === undefined) {
    return {
      title: "Nothing running",
      mono: false,
      danger: true,
      lines: [when],
      note: "No span covers this stretch of the path, which usually means missing data rather than a real pause.",
      hint: "Click to zoom to it.",
    };
  }
  const row = s.row === undefined ? undefined : m.rows[s.row];
  const who = row === undefined ? "" : `${row.name} · `;
  return {
    title: s.label ?? KIND_WORD[s.kind],
    mono: s.label !== undefined,
    tag: CAT_LABEL[s.cat],
    lines: [`${who}${when}`],
    note: "On the critical path: the work's wall time is these steps end to end.",
    hint: "Click to open it.",
  };
};
