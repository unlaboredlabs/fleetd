// The builder every fixture is made with. It holds a FixtureFile (src/main/hub/fixture.ts, the format main loads) and
// adds the things a writer would otherwise get wrong by hand: answers replace an earlier answer to the same input,
// and the most specific input is matched first, so `answer("order_get", {workstreamId: "W2"}, …)` after a catch-all
// still wins.
import type { HubState } from "../../src/shared/hub.ts";
import type { FixtureFile } from "../../src/main/hub/fixture.ts";
import { asText, clone, isObject, type JsonObject, type JsonValue } from "./json.ts";

export type FixtureFrame = FixtureFile["frames"][number];
export type FixtureCall = FixtureFile["calls"][number];
export interface HubErrorJson {
  readonly code: string;
  readonly message: string;
  readonly fix?: string | undefined;
}

type TimedKind = "event" | "live" | "snapshot" | "chat_delta" | "state";

/** Rows of `tool`'s answers under `field` matching `where`, e.g. requests_list's requests with requestId Q1. */
export interface Rows {
  readonly tool: string;
  readonly field: string;
  readonly where: JsonObject;
}

/**
 * What answering a call changes, as the hub would (main's FixtureSource applies it): frames `ms` after the call, and
 * rows later answers leave out (`hide`) or include again (`show`).
 */
export interface CallThen {
  readonly frames?: ReadonlyArray<{ readonly ms: number; readonly kind: TimedKind; readonly payload: JsonObject }>;
  readonly hide?: ReadonlyArray<Rows>;
  readonly show?: ReadonlyArray<Rows>;
}

/** src/main/hub/fixture.ts: the longest gap between frames, and the longest call delay. */
const MAX_AFTER_MS = 600_000;

export const HUB = "http://devbox:4790";
export const PROTOCOL = 1;
/** Every generated fixture's clock: a Monday mid-morning, so "today" and "this week" have data on both sides. */
export const NOW = "2026-10-19T10:30:00.000Z";

const leaves = (v: JsonValue | undefined): number =>
  Array.isArray(v) ? v.reduce<number>((n, x) => n + leaves(x), 0) : isObject(v) ? Object.values(v).reduce<number>((n, x) => n + leaves(x), 0) : v === undefined ? 0 : 1;

const sameJson = (a: JsonValue | undefined, b: JsonValue | undefined) => JSON.stringify(a) === JSON.stringify(b);

const timedFrame = (kind: TimedKind, payload: JsonObject, afterMs: number): FixtureFrame => {
  const num = (v: JsonValue | undefined) => (typeof v === "number" ? v : 0);
  if (kind === "snapshot") return { t: "snapshot", snapshot: { ...payload, cursor: num(payload["cursor"]) }, afterMs };
  if (kind === "event") return { t: "event", event: { ...payload, seq: num(payload["seq"]), type: asText(payload["type"]) }, afterMs };
  if (kind === "state") return { t: "state", state: payload as unknown as HubState, afterMs };
  if (kind === "chat_delta") {
    const delta = { ...payload, messageId: asText(payload["messageId"]), offset: num(payload["offset"]), append: asText(payload["append"]) };
    return { t: "chat_delta", delta, afterMs };
  }
  return { t: "live", frame: { ...payload, full: payload["full"] === true }, afterMs };
};

/** A CallThen as main reads it: each frame `afterMs` after the one before (the first after the call). */
const thenFile = (then: CallThen): NonNullable<FixtureCall["then"]> => {
  let previous = 0;
  const frames = (then.frames ?? []).toSorted((a, b) => a.ms - b.ms).map(({ ms, kind, payload }) => {
    const afterMs = Math.max(0, Math.round(ms - previous));
    previous = ms;
    return timedFrame(kind, payload, afterMs);
  });
  return {
    ...(frames.length === 0 ? {} : { frames }),
    ...(then.hide === undefined ? {} : { hide: then.hide.map((r) => ({ ...r })) }),
    ...(then.show === undefined ? {} : { show: then.show.map((r) => ({ ...r })) }),
  };
};

export class Fixture {
  readonly name: string;
  note: string;
  now: string = NOW;
  state: HubState = { phase: "live", hub: HUB, protocol: PROTOCOL };
  connect: FixtureFile["connect"];
  snapshot: JsonObject | undefined;
  events: Array<JsonObject> = [];
  live: Array<JsonObject> = [];
  errors: Array<HubErrorJson> = [];
  /** Tools whose answers follow a contract change still on its branch; skipped by validation until it merges. */
  pendingContracts = new Map<string, string>();
  /** The slot state is this fixture's point: lanes are made to match it, rather than it to the lanes (kit/agents.ts). */
  agentsFromSlots = false;
  /** Frames that arrive `ms` after the app subscribes, for progress over time; see later(). */
  timeline: Array<{ ms: number; kind: TimedKind; payload: JsonObject }> = [];
  /** When the screen is final, for the QA harness to screenshot; defaults to the last timed frame. */
  settleMs: number | undefined;
  calls: Array<{ tool: string; input: JsonObject | undefined; output?: JsonValue; error?: HubErrorJson; delayMs?: number; then?: CallThen }> = [];
  /**
   * What pairing finds instead of the network (src/main/pairing/fixture.ts): app-pair.json, the hub's /healthz and
   * /pair answers, and where the key would be kept. Absent: no file, no hub answers, the OS store.
   */
  pair: JsonObject | undefined;

  constructor(name: string, note: string) {
    this.name = name;
    this.note = note;
  }

  /** A copy under a new name: the base's data, nothing shared. */
  static from(base: Fixture, name: string, note: string): Fixture {
    const f = new Fixture(name, note);
    f.now = base.now;
    f.state = { ...base.state };
    f.connect = base.connect;
    f.pair = base.pair === undefined ? undefined : clone(base.pair);
    f.snapshot = base.snapshot === undefined ? undefined : clone(base.snapshot);
    f.events = clone(base.events);
    f.live = clone(base.live);
    f.errors = base.errors.map((e) => ({ ...e }));
    f.pendingContracts = new Map(base.pendingContracts);
    f.agentsFromSlots = base.agentsFromSlots;
    f.timeline = base.timeline.map((t) => ({ ...t, payload: clone(t.payload) }));
    f.settleMs = base.settleMs;
    f.calls = base.calls.map((c) => ({ ...c, ...(c.input === undefined ? {} : { input: clone(c.input) }), ...(c.output === undefined ? {} : { output: clone(c.output) }) }));
    return f;
  }

  /** A fixture from a file main could load (a recorded one, or another writer's output). */
  static fromFile(file: FixtureFile, name: string = file.name, note: string = file.note): Fixture {
    const f = new Fixture(name, note);
    f.now = file.now;
    f.state = file.state;
    f.connect = file.connect;
    const settle = (file as { settleMs?: unknown }).settleMs;
    if (typeof settle === "number") f.settleMs = settle;
    let ms = 0;
    for (const frame of file.frames) {
      ms += frame.afterMs ?? 0;
      // A streamed chat frame or a change of connection only makes sense on the timeline, after the first page.
      if ((ms > 0 || frame.t === "chat_delta" || frame.t === "state") && frame.t !== "error") {
        const payload =
          frame.t === "snapshot"
            ? frame.snapshot
            : frame.t === "event"
              ? frame.event
              : frame.t === "chat_delta"
                ? frame.delta
                : frame.t === "state"
                  ? frame.state
                  : frame.frame;
        f.timeline.push({ ms, kind: frame.t, payload: clone(payload as JsonObject) });
      } else if (frame.t === "snapshot") f.snapshot = clone(frame.snapshot as JsonObject);
      else if (frame.t === "event") f.events.push(clone(frame.event as JsonObject));
      else if (frame.t === "live") f.live.push(clone(frame.frame as JsonObject));
      else f.errors.push({ ...frame.error });
    }
    for (const c of file.calls) {
      const input = c.input as JsonObject | undefined;
      if (c.outcome.ok) f.answer(c.tool, input, clone(c.outcome.output), c.delayMs);
      else f.fail(c.tool, input, { ...c.outcome.error }, c.delayMs);
    }
    return f;
  }

  /**
   * A frame `ms` after the app subscribes (a hub event, a live frame, or a whole new snapshot as after a resync), so a
   * fixture can show progress: a clone filling up, text streaming in, a status going stale. Calls stay as answered;
   * the screen's refetches after an event get the same answer.
   */
  later(ms: number, kind: TimedKind, payload: JsonObject): this {
    this.timeline.push({ ms, kind, payload });
    return this;
  }

  /** The QA harness screenshots once `ms` have passed (and the page is stable), not at the first stable frame. */
  settleAt(ms: number): this {
    this.settleMs = ms;
    return this;
  }

  /** Answers `tool` for inputs containing `input` (undefined: any input). Replaces an answer to the same input. */
  answer(tool: string, input: JsonObject | undefined, output: JsonValue, delayMs?: number): this {
    this.#put({ tool, input, output, ...(delayMs === undefined ? {} : { delayMs }) });
    return this;
  }

  /** What answering `tool` for exactly this input changes afterwards (see CallThen); the answer must exist. */
  then(tool: string, input: JsonObject | undefined, then: CallThen): this {
    const call = this.calls.find((c) => c.tool === tool && sameJson(c.input, input));
    if (call === undefined) throw new Error(`${this.name}: then() for ${tool} ${JSON.stringify(input)}, which has no answer`);
    call.then = then;
    return this;
  }

  /** Makes `tool` fail with a hub error for inputs containing `input`. */
  fail(tool: string, input: JsonObject | undefined, error: HubErrorJson, delayMs?: number): this {
    this.#put({ tool, input, error, ...(delayMs === undefined ? {} : { delayMs }) });
    return this;
  }

  /** Removes every answer for `tool` (all of them when `input` is undefined). */
  drop(tool: string, input?: JsonObject): this {
    this.calls = this.calls.filter((c) => c.tool !== tool || (input !== undefined && !sameJson(c.input, input)));
    return this;
  }

  /** The successful answers for `tool`, to read or change in place. */
  answers(tool: string): Array<{ readonly input: JsonObject | undefined; output: JsonValue }> {
    return this.calls.flatMap((c) => (c.tool === tool && c.output !== undefined ? [c as { input: JsonObject | undefined; output: JsonValue }] : []));
  }

  /** The answer to exactly this input, if there is one. */
  output(tool: string, input?: JsonObject): JsonValue | undefined {
    return this.calls.find((c) => c.tool === tool && sameJson(c.input, input))?.output;
  }

  /** Rewrites every successful answer of `tool`. */
  update(tool: string, change: (output: JsonValue, input: JsonObject | undefined) => JsonValue): this {
    for (const c of this.calls) if (c.tool === tool && c.output !== undefined) c.output = change(c.output, c.input);
    return this;
  }

  #put(call: Fixture["calls"][number]) {
    const i = this.calls.findIndex((c) => c.tool === call.tool && sameJson(c.input, call.input));
    if (i >= 0) this.calls[i] = call;
    else this.calls.push(call);
  }

  /** The file main loads. Within a tool, more specific inputs come first, since main takes the first match. */
  toFile(): FixtureFile & { settleMs?: number; pair?: JsonObject } {
    const frames: Array<FixtureFrame> = [];
    const num = (v: JsonValue | undefined) => (typeof v === "number" ? v : 0);
    if (this.snapshot !== undefined) frames.push({ t: "snapshot", snapshot: { ...this.snapshot, cursor: num(this.snapshot["cursor"]) } });
    for (const e of this.events) frames.push({ t: "event", event: { ...e, seq: num(e["seq"]), type: asText(e["type"]) } });
    for (const frame of this.live) frames.push({ t: "live", frame: { ...frame, full: frame["full"] === true } });
    for (const error of this.errors) frames.push({ t: "error", error: { ...error } });
    // Main replays each frame `afterMs` after the one before it.
    let previous = 0;
    for (const { ms, kind, payload } of this.timeline.toSorted((a, b) => a.ms - b.ms)) {
      const afterMs = Math.max(0, Math.round(ms - previous));
      if (afterMs > MAX_AFTER_MS) throw new Error(`${this.name}: a frame ${afterMs} ms after the one before it; main allows ${MAX_AFTER_MS}`);
      previous = Math.max(previous, ms);
      frames.push(timedFrame(kind, payload, afterMs));
    }
    // A delayed answer is part of what the screen waits for, too.
    const slowest = Math.max(0, ...this.calls.map((c) => c.delayMs ?? 0));
    const settleMs = this.settleMs ?? (this.timeline.length > 0 || slowest > 0 ? Math.max(previous, slowest) : undefined);
    const calls = this.calls
      .map((c, i) => ({ c, i }))
      .toSorted((a, b) => a.c.tool.localeCompare(b.c.tool) || leaves(b.c.input) - leaves(a.c.input) || a.i - b.i)
      .map(({ c }): FixtureCall => ({
        tool: c.tool,
        ...(c.input === undefined ? {} : { input: c.input }),
        outcome: c.error === undefined ? { ok: true, output: c.output ?? null } : { ok: false, error: { ...c.error } },
        ...(c.delayMs === undefined ? {} : { delayMs: c.delayMs }),
        ...(c.then === undefined ? {} : { then: thenFile(c.then) }),
      }));
    return {
      version: 1,
      name: this.name,
      note: this.note,
      now: this.now,
      state: this.state,
      frames,
      calls,
      ...(this.connect === undefined ? {} : { connect: this.connect }),
      ...(settleMs === undefined ? {} : { settleMs }),
      ...(this.pair === undefined ? {} : { pair: this.pair }),
    };
  }
}
