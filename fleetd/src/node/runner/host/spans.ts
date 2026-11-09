// Time spans from claude's stream, built beside the mapper as a pure
// state machine over the same lines and the same clock. Every span of a run is emitted when the run ends: only then is
// each instant's owner known, so each span carries its exclusive time and the run's uncovered time becomes
// `runner.other` filler. Per run, the exclusive times add up to the run's wall time exactly.
//
// A model message runs from the previous visible event to its `message_stop`; its first phase ends at `message_start`
// (claude-local work, network, queueing and prefill, which cannot be told apart), its thinking phase ends with its last
// thinking block, and the rest is output. A tool runs from its `tool_use` block to its `tool_result`.
import type { SpanExtra, SpanKind, SpanStatus } from "../../../shared/contracts.ts";
import { exclusive, tile, type Claim } from "../../../shared/tiles.ts";
import { rank } from "../../../hub/time/model.ts";
import { program } from "../../../hub/time/store.ts";
import { headUtf16 } from "../../util.ts";
import type { DecidedBy } from "./events.ts";

/** A span as the node sends it. */
export type SpanWire = {
  key: string;
  kind: SpanKind;
  sessionId: string;
  runId?: string;
  parent?: string;
  startMs: number;
  endMs: number;
  exclMs?: number;
  label?: string;
  exitCode?: number;
  outBytes?: number;
  status: SpanStatus;
  extra?: SpanExtra;
};

/** A run with more spans than this keeps the first ones and reports the rest as one `gap`. */
export const MAX_RUN_SPANS = 5000;
const LABEL_MAX = 500;

type Leaf = {
  key: string;
  kind: SpanKind;
  parent?: string;
  start: number;
  end: number;
  label?: string;
  exitCode?: number;
  outBytes?: number;
  status: SpanStatus;
  extra: SpanExtra;
  /** Owns no instant: the run envelope, or a message whose phases tile it. */
  envelope: boolean;
};

type OpenRun = { start: number; leaves: Leaf[]; dropped: number };
type OpenMessage = {
  id: string;
  opened: number;
  started: number;
  /** Content block index -> its type, for `content_block_stop`. */
  blocks: Map<number, string>;
  thinkingEnd?: number;
  stopReason?: string;
  outputTokens?: number;
  thinkingTokens?: number;
};
type OpenTool = { run?: string; start: number; name: string; label: string };
type OpenWait = { run?: string; key: string; parent?: string; kind: SpanKind; start: number; extra: SpanExtra };

const leaf = (key: string, kind: SpanKind, parent: string | undefined, start: number, end: number, label: string | undefined, status: SpanStatus, extra: SpanExtra, envelope: boolean): Leaf => ({
  key,
  kind,
  ...(parent !== undefined ? { parent } : {}),
  start,
  end,
  ...(label !== undefined ? { label } : {}),
  status,
  extra,
  envelope,
});

/** A bounded text field: none when empty, as the contract's `Text<1, n>` refuses it. */
const text = (s: string | undefined, max: number) => (s ? headUtf16(s, max) : undefined);
const uint = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined);

function extraOf(fields: SpanExtra): SpanExtra {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out as SpanExtra;
}

export class SpanBuilder {
  #runs = new Map<string, OpenRun>();
  #active: string | undefined;
  /** The active run's previous visible stream event: where the next model message starts. */
  #lastVisible = 0;
  #message: OpenMessage | undefined;
  #tools = new Map<string, OpenTool>();
  /** Permission prompts by request id. */
  #permissions = new Map<string, OpenWait>();
  #retry: OpenWait | undefined;
  #compaction: OpenWait | undefined;
  #seq = 0;

  constructor(readonly session: string) {}

  runStarted(run: string, ms: number): void {
    if (!this.#runs.has(run)) this.#runs.set(run, { start: ms, leaves: [], dropped: 0 });
    this.#active = run;
    this.#lastVisible = ms;
    this.#message = undefined;
  }

  /** One `stream_event` of the active run. */
  stream(ev: any, ms: number): void {
    const index = uint(ev?.index);
    switch (typeof ev?.type === "string" ? ev.type : "") {
      case "message_start":
        this.#closeRetry(ms);
        this.#message = { id: typeof ev.message?.id === "string" ? ev.message.id : "", opened: Math.min(this.#lastVisible, ms), started: ms, blocks: new Map() };
        break;
      case "content_block_start":
        if (this.#message && index !== undefined) this.#message.blocks.set(index, typeof ev.content_block?.type === "string" ? ev.content_block.type : "");
        break;
      case "content_block_stop":
        if (this.#message && index !== undefined && this.#message.blocks.get(index) === "thinking") this.#message.thinkingEnd = ms;
        break;
      case "message_delta": {
        const m = this.#message;
        if (!m) break;
        if (typeof ev.delta?.stop_reason === "string") m.stopReason = ev.delta.stop_reason;
        const out = uint(ev.usage?.output_tokens);
        if (out !== undefined) m.outputTokens = out;
        const thinking = uint(ev.usage?.output_tokens_details?.thinking_tokens);
        if (thinking !== undefined) m.thinkingTokens = thinking;
        break;
      }
      case "message_stop": {
        const m = this.#message;
        this.#message = undefined;
        if (m) this.#closeMessage(m, ms, "ok");
        this.#lastVisible = ms;
        break;
      }
    }
  }

  #closeMessage(m: OpenMessage, end: number, status: SpanStatus): void {
    const run = this.#active;
    if (run === undefined) return;
    const key = `${this.session}/msg/${m.id}`;
    const first = Math.min(m.started, end);
    const thinking = m.thinkingEnd === undefined ? undefined : Math.min(Math.max(m.thinkingEnd, first), end);
    const extra = extraOf({
      outputTokens: m.outputTokens,
      thinkingTokens: m.thinkingTokens,
      stopReason: text(m.stopReason, 40),
      reason: status !== "ok" ? "the run ended before the message did" : undefined,
    });
    const phases: [SpanKind, number, number][] = [
      ["model.first_token", m.opened, first],
      ["model.thinking", first, thinking ?? first],
      ["model.output", thinking ?? first, end],
    ];
    this.#push(run, leaf(key, "model.message", undefined, m.opened, end, undefined, status, extra, true));
    for (const [kind, start, stop] of phases)
      if (stop > start) this.#push(run, leaf(`${key}/${kind.replace(/^model\./, "")}`, kind, key, start, stop, undefined, status, {}, false));
  }

  /** The `assistant` line's `tool_use` block. */
  toolUse(id: string, name: string, input: unknown, ms: number): void {
    this.#tools.set(id, { ...(this.#active !== undefined ? { run: this.#active } : {}), start: ms, name, label: toolLabel(name, input) });
  }

  /** The `user` line's `tool_result`. `output` is the full result text, before any cap. */
  toolResult(id: string, output: string, status: SpanStatus, exitCode: number | undefined, toolUseResult: unknown, ms: number): void {
    const tool = this.#tools.get(id);
    if (!tool) return;
    this.#tools.delete(id);
    this.#lastVisible = ms;
    const runnerMs = uint((toolUseResult as { durationMs?: unknown } | undefined)?.durationMs);
    this.#closeTool(id, tool, ms, status, exitCode, Buffer.byteLength(output), runnerMs);
  }

  #closeTool(id: string, tool: OpenTool, end: number, status: SpanStatus, exitCode: number | undefined, outBytes: number | undefined, runnerMs: number | undefined): void {
    const run = tool.run ?? this.#active;
    if (run === undefined) return;
    const l = leaf(`${this.session}/${id}`, toolKind(tool.name, tool.label), undefined, tool.start, Math.max(end, tool.start), tool.label, status, extraOf({ tool: text(tool.name, 120), runnerMs }), false);
    if (exitCode !== undefined) l.exitCode = exitCode;
    if (outBytes !== undefined) l.outBytes = outBytes;
    this.#push(run, l);
  }

  /** `can_use_tool`: the prompt opens; it closes with `answered` or `withdrawn`. */
  permission(requestId: string, toolUseId: string, toolName: string, ms: number): void {
    this.#permissions.set(requestId, {
      ...(this.#active !== undefined ? { run: this.#active } : {}),
      key: `${this.session}/perm/${requestId}`,
      ...(toolUseId ? { parent: `${this.session}/${toolUseId}` } : {}),
      kind: "wait.permission",
      start: ms,
      extra: extraOf({ requestId: text(requestId, 120), tool: text(toolName, 120) }),
    });
  }

  answered(requestId: string, by: DecidedBy | undefined, ms: number): void {
    const w = this.#permissions.get(requestId);
    if (!w) return;
    this.#permissions.delete(requestId);
    if (by !== undefined) w.extra = { ...w.extra, decidedBy: by };
    this.#closeWait(w, ms, "ok");
  }

  withdrawn(requestId: string, ms: number): void {
    const w = this.#permissions.get(requestId);
    if (!w) return;
    this.#permissions.delete(requestId);
    this.#closeWait(w, ms, "cancelled");
  }

  apiRetry(attempt: number, delayMs: number | undefined, status: number | undefined, ms: number): void {
    this.#closeRetry(ms);
    this.#seq++;
    this.#retry = {
      ...(this.#active !== undefined ? { run: this.#active } : {}),
      key: `${this.session}/${this.#active ?? ""}/retry/${this.#seq}`,
      kind: "wait.retry.api",
      start: ms,
      extra: extraOf({ attempt, statedDelayMs: delayMs, httpStatus: status }),
    };
  }

  #closeRetry(ms: number): void {
    const w = this.#retry;
    this.#retry = undefined;
    if (w) this.#closeWait(w, ms, "ok");
  }

  compacting(on: boolean, ms: number): void {
    if (on && !this.#compaction) {
      this.#seq++;
      this.#compaction = {
        ...(this.#active !== undefined ? { run: this.#active } : {}),
        key: `${this.session}/${this.#active ?? ""}/compact/${this.#seq}`,
        kind: "compaction",
        start: ms,
        extra: {},
      };
    } else if (!on && this.#compaction) {
      const w = this.#compaction;
      this.#compaction = undefined;
      this.#closeWait(w, ms, "ok");
    }
  }

  #closeWait(w: OpenWait, end: number, status: SpanStatus): void {
    const run = w.run ?? this.#active;
    if (run === undefined) return;
    this.#push(run, leaf(w.key, w.kind, w.parent, w.start, Math.max(end, w.start), undefined, status, w.extra, false));
  }

  #push(run: string, l: Leaf): void {
    const open = this.#runs.get(run);
    if (!open) return;
    if (open.leaves.length >= MAX_RUN_SPANS) open.dropped++;
    else open.leaves.push(l);
  }

  /** The run ended at `ms`: whatever it left open is cut, every span of the run comes back with its exclusive time, and
   * the uncovered time is `runner.other`. Nothing when the run never started. */
  runEnded(run: string, status: SpanStatus, durations: [number | undefined, number | undefined], ms: number): SpanWire[] {
    const open = this.#runs.get(run);
    if (!open) return [];
    const isActive = this.#active === run;
    if (isActive) {
      const m = this.#message;
      this.#message = undefined;
      if (m) this.#closeMessage(m, ms, "incomplete");
      const retry = this.#retry;
      this.#retry = undefined;
      if (retry) this.#closeWait(retry, ms, "incomplete");
      const compaction = this.#compaction;
      this.#compaction = undefined;
      if (compaction) this.#closeWait(compaction, ms, "incomplete");
    }
    const cut = [...this.#tools].filter(([, t]) => t.run === undefined || t.run === run).map(([id]) => id).sort();
    for (const id of cut) {
      const tool = this.#tools.get(id)!;
      this.#tools.delete(id);
      this.#closeTool(id, { ...tool, run }, ms, "cancelled", undefined, undefined, undefined);
    }
    const waits = [...this.#permissions].filter(([, w]) => w.run === undefined || w.run === run).map(([id]) => id).sort();
    for (const id of waits) {
      const w = this.#permissions.get(id)!;
      this.#permissions.delete(id);
      this.#closeWait(w, ms, "cancelled");
    }
    if (isActive) this.#active = undefined;
    this.#runs.delete(run);
    return finish(this.session, run, open, status, durations, ms);
  }
}

/** Groups overlapping tool calls, tiles the run and turns its leaves into wire spans. */
function finish(session: string, run: string, open: OpenRun, status: SpanStatus, [durationMs, durationApiMs]: [number | undefined, number | undefined], end: number): SpanWire[] {
  const start = Math.min(open.start, end);
  for (const l of open.leaves) {
    l.start = Math.min(Math.max(l.start, start), end);
    l.end = Math.min(Math.max(l.end, l.start), end);
  }
  groupParallel(session, run, open.leaves);
  const claims: Claim[] = open.leaves.map((l) => ({ start: l.start, end: l.end, rank: l.envelope ? 0 : Math.max(rank(l.kind), 1) }));
  const tiles = tile(claims, start, end);
  const { excl } = exclusive(claims, start, end);
  const out: SpanWire[] = [];
  const runKey = `${session}/${run}/run`;
  let fillers = 0;
  for (const t of tiles) {
    if (t.owner !== undefined) continue;
    fillers++;
    out.push(wire(session, run, leaf(`${session}/${run}/other/${fillers}`, "runner.other", runKey, t.start, t.end, undefined, "ok", {}, false), t.end - t.start));
  }
  if (open.dropped > 0) {
    const extra = { count: open.dropped, reason: `the run had more than ${MAX_RUN_SPANS} spans` };
    out.push(wire(session, run, leaf(`${session}/${run}/gap/1`, "gap", runKey, start, end, undefined, "incomplete", extra, true), 0));
  }
  open.leaves.forEach((l, i) => {
    if (l.parent === undefined) l.parent = runKey;
    out.push(wire(session, run, l, excl[i]));
  });
  const envelope = leaf(runKey, "run", undefined, start, end, undefined, status, extraOf({ durationMs, durationApiMs }), true);
  out.push(wire(session, run, envelope, 0));
  // Rust sorts by (start, key) with byte order on the key.
  return out.sort((a, b) => a.startMs - b.startMs || Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
}

/** Where two or more tool calls overlap, one `tools.parallel` span owns the overlap and becomes their parent. */
function groupParallel(session: string, run: string, leaves: Leaf[]): void {
  const tools = leaves.flatMap((l, i) => (rank(l.kind) === 6 && l.end > l.start ? [i] : []));
  if (tools.length < 2) return;
  const edges: [number, number][] = tools.flatMap((i) => [
    [leaves[i]!.start, 1],
    [leaves[i]!.end, -1],
  ]);
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const regions: [number, number][] = [];
  let depth = 0;
  let openAt: number | undefined;
  for (const [t, d] of edges) {
    depth += d;
    if (depth >= 2 && openAt === undefined) openAt = t;
    else if (depth < 2 && openAt !== undefined) {
      if (t > openAt) regions.push([openAt, t]);
      openAt = undefined;
    }
  }
  regions.forEach(([s, e], n) => {
    const key = `${session}/${run}/par/${n + 1}`;
    for (const i of tools) if (leaves[i]!.start < e && leaves[i]!.end > s) leaves[i]!.parent = key;
    leaves.push(leaf(key, "tools.parallel", undefined, s, e, undefined, "ok", {}, false));
  });
}

function wire(session: string, run: string, l: Leaf, excl: number | undefined): SpanWire {
  const runId = text(run, 120);
  return {
    key: headUtf16(l.key, 300),
    kind: l.kind,
    sessionId: session,
    ...(runId !== undefined ? { runId } : {}),
    ...(l.parent !== undefined ? { parent: headUtf16(l.parent, 300) } : {}),
    startMs: l.start,
    endMs: l.end,
    ...(excl !== undefined ? { exclMs: excl } : {}),
    ...(l.label !== undefined ? { label: headUtf16(l.label, LABEL_MAX) } : {}),
    ...(l.exitCode !== undefined ? { exitCode: l.exitCode } : {}),
    ...(l.outBytes !== undefined ? { outBytes: l.outBytes } : {}),
    status: l.status,
    ...(Object.keys(l.extra).length ? { extra: l.extra } : {}),
  };
}

/** The command, the path or the tool's main argument. */
function toolLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const field = (k: string) => (typeof i[k] === "string" && i[k] ? (i[k] as string) : undefined);
  const byName: Record<string, string> = {
    Bash: "command",
    Read: "file_path",
    Edit: "file_path",
    MultiEdit: "file_path",
    Write: "file_path",
    NotebookEdit: "notebook_path",
    Grep: "pattern",
    Glob: "pattern",
    LS: "path",
    WebFetch: "url",
    WebSearch: "query",
  };
  const found = byName[name] !== undefined ? field(byName[name]!) : undefined;
  if (found !== undefined) return headUtf16(found, LABEL_MAX);
  if (name.startsWith("mcp__")) {
    // serde_json's maps are sorted by key, so the first is the smallest.
    const first = input !== null && typeof input === "object" && !Array.isArray(input) ? Object.keys(input).sort()[0] : undefined;
    if (first === undefined) return name;
    const v = (input as Record<string, unknown>)[first];
    return `${name} ${first}=${headUtf16(typeof v === "string" ? v : JSON.stringify(v), 200)}`;
  }
  return name;
}

function toolKind(name: string, label: string): SpanKind {
  switch (name) {
    case "Bash": {
      const p = program(label);
      return p === "git" || p === "gh" ? "git" : "tool.bash";
    }
    case "Read":
    case "Grep":
    case "Glob":
    case "LS":
      return "tool.read";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "tool.edit";
    case "WebFetch":
    case "WebSearch":
      return "tool.web";
    default:
      return name.startsWith("mcp__") ? "tool.mcp" : "tool.other";
  }
}
