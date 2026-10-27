// FLEETD_FIXTURE=<name>: the hub replaced by a file, so screenshots and Playwright need no hub. The files are made
// by `pnpm fixtures` (fixtures/kit); main checks only the envelope, payloads go to the renderer as they are.
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { CallOutcome, ConnectOutcome, HubFrame, HubState } from "../../shared/hub";
import type { CallRequest } from "../../shared/ipc";
import type { HubSource } from "./source";

const delay = z.int().min(0).max(600_000).optional();
const hubError = z.object({ code: z.string(), message: z.string(), fix: z.string().optional() });

const State = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("unpaired"), note: z.string().optional() }),
  z.object({ phase: z.literal("connecting"), hub: z.string(), attempt: z.int().min(0) }),
  z.object({ phase: z.literal("live"), hub: z.string(), protocol: z.int(), version: z.string().optional(), features: z.array(z.string()).readonly().optional() }),
  z.object({ phase: z.literal("retrying"), hub: z.string(), reason: z.string(), fix: z.string().optional(), retryAt: z.number() }),
  z.object({ phase: z.literal("refused"), hub: z.string(), message: z.string() }),
]);

/** Items of `tool`'s answers under `field` that match `where` (a deep subset), e.g. requests_list's open Q1. */
const Rows = z.object({ tool: z.string(), field: z.string(), where: z.json() });

const Frame = z.discriminatedUnion("t", [
  // The connection changing mid-run, as a hub restart does: retrying, then live again and a fresh snapshot.
  z.object({ t: z.literal("state"), state: State, afterMs: delay }),
  z.object({ t: z.literal("snapshot"), snapshot: z.looseObject({ cursor: z.int().min(0) }), afterMs: delay }),
  z.object({ t: z.literal("event"), event: z.looseObject({ seq: z.int().min(0), type: z.string() }), afterMs: delay }),
  z.object({ t: z.literal("live"), frame: z.looseObject({ full: z.boolean() }), afterMs: delay }),
  z.object({ t: z.literal("error"), error: hubError, afterMs: delay }),
  // A streamed chat frame, replayed whatever chat is subscribed: a fixture streams the chat it shows.
  z.object({
    t: z.literal("chat_delta"),
    delta: z.looseObject({ messageId: z.string(), offset: z.int().min(0), append: z.string() }),
    afterMs: delay,
  }),
  // Not sent to the window: rows later answers leave out or include again from now on, so a fixture's answers move on
  // over time as a hub's do (fixtures/showcase plays one order from request to merge).
  z.object({ t: z.literal("rows"), hide: z.array(Rows).optional(), show: z.array(Rows).optional(), afterMs: delay }),
  // A browser session's page, replayed whatever is watched (the renderer shows the watched session's only).
  z.object({
    t: z.literal("browser_frame"),
    frame: z.looseObject({ sessionId: z.string(), seq: z.int().min(0), jpegB64: z.string(), width: z.int().min(1), height: z.int().min(1), control: z.string() }),
    afterMs: delay,
  }),
]);

/**
 * What answering a call changes, as a hub would: frames it emits (each `afterMs` after the call, e.g. a request's
 * request.updated as it runs) and rows it hides from later answers or shows again (an answered request leaves the
 * open requests_list), so a refetch after the event agrees with it.
 */
const Then = z.object({
  frames: z.array(Frame).optional(),
  hide: z.array(Rows).optional(),
  show: z.array(Rows).optional(),
});

const FixtureFile = z.object({
  version: z.literal(1),
  name: z.string(),
  note: z.string(),
  now: z.iso.datetime({ offset: true }),
  state: State,
  frames: z.array(Frame),
  calls: z.array(
    z.object({
      tool: z.string(),
      input: z.json().optional(),
      outcome: z.union([z.object({ ok: z.literal(true), output: z.json() }), z.object({ ok: z.literal(false), error: hubError })]),
      delayMs: delay,
      then: Then.optional(),
    }),
  ),
  connect: z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), message: z.string() })]).optional(),
  /** The renderer's disk cache as an earlier launch left it (src/renderer/src/data/cache.ts); never written over. */
  cache: z.json().optional(),
  /** Rows hidden from the first answer on, until a rows frame shows them. */
  hidden: z.array(Rows).optional(),
});
export type FixtureFile = z.infer<typeof FixtureFile>;

/**
 * Which fixture, if any, replaces the hub. A release build ignores FLEETD_FIXTURE: fake data must never pass for a real
 * hub. QA and the packaged smoke run the test build.
 */
export const fixtureRequest = (
  vars: NodeJS.ProcessEnv,
  release: boolean,
): { kind: "none" } | { kind: "ignored"; reason: string } | { kind: "fixture"; name: string } => {
  const name = vars["FLEETD_FIXTURE"];
  if (name === undefined || name === "") return { kind: "none" };
  if (release) return { kind: "ignored", reason: "FLEETD_FIXTURE is ignored in a release build." };
  return { kind: "fixture", name };
};

/** FLEETD_FIXTURE is a name in FLEETD_FIXTURE_DIR (default <app>/fixtures) or an absolute path. Throws a readable message. */
export const loadFixture = (fixture: string, dir: string): FixtureFile => {
  const file = isAbsolute(fixture) ? fixture : join(dir, `${fixture}.json`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (cause) {
    throw new Error(`Fixture ${file} not found; run pnpm fixtures.`, { cause });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Fixture ${file} isn't JSON: ${String(cause)}`, { cause });
  }
  const parsed = FixtureFile.safeParse(json);
  if (!parsed.success) throw new Error(`Fixture ${file} doesn't match the format:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
};

/** Whether every field of `part` is in `whole` (objects recursively; arrays and scalars must be equal). */
export const matches = (part: unknown, whole: unknown): boolean => {
  if (part === null || typeof part !== "object") return Object.is(part, whole);
  if (whole === null || typeof whole !== "object") return false;
  if (Array.isArray(part)) {
    return Array.isArray(whole) && part.length === whole.length && part.every((item, i) => matches(item, whole[i]) && matches(whole[i], item));
  }
  if (Array.isArray(whole)) return false;
  const record = whole as Record<string, unknown>;
  return Object.entries(part).every(([key, value]) => key in record && matches(value, record[key]));
};

/** chat_send's message under the sender's own clientRequestId, as a hub keeps it: the app's row becomes that message. */
const echoRequestId = (request: CallRequest, outcome: CallOutcome): CallOutcome => {
  const id = (request.input as { clientRequestId?: unknown } | null | undefined)?.clientRequestId;
  const message = outcome.ok ? (outcome.output as { message?: unknown } | null)?.message : undefined;
  if (!outcome.ok || request.tool !== "chat_send" || typeof id !== "string" || message === null || typeof message !== "object") return outcome;
  return { ok: true, output: { ...(outcome.output as object), message: { ...message, clientRequestId: id } } };
};

export class FixtureSource implements HubSource {
  readonly #file: FixtureFile;
  readonly #emit: (frame: HubFrame) => void;
  #replay: Array<ReturnType<typeof setTimeout>> = [];
  /** Rows answered calls and rows frames have hidden (see Then); a resync keeps them, as a hub keeps what was answered. */
  #hidden: Array<z.infer<typeof Rows>>;
  /** The last event number sent: a call's events are numbered as they happen, after everything sent before. */
  #seq = 0;
  /** The connection as the replay left it; a window subscribing later starts from it. */
  #state: HubState;
  /** The watched browser session, and each session's newest frame: as a hub, it sends only the watched one's. */
  #watch: string | null = null;
  readonly #frames = new Map<string, HubFrame & { t: "browser_frame" }>();
  readonly #out: (frame: HubFrame) => void;

  constructor(file: FixtureFile, emit: (frame: HubFrame) => void) {
    this.#file = file;
    this.#out = emit;
    this.#state = file.state;
    this.#hidden = [...(file.hidden ?? [])];
    this.#emit = (frame) => {
      if (frame.t === "browser_frame") {
        this.#frames.set(frame.frame.sessionId, frame);
        if (frame.frame.sessionId !== this.#watch) return;
      }
      if (frame.t === "state") this.#state = frame.state;
      if (frame.t === "event") this.#seq = Math.max(this.#seq, frame.event.seq);
      if (frame.t === "snapshot") this.#seq = Math.max(this.#seq, frame.snapshot.cursor);
      emit(frame);
    };
  }

  get state(): HubState {
    return this.#state;
  }

  get connectAnswer(): ConnectOutcome {
    return this.#file.connect ?? { ok: false, message: "This is a fixture; it can't pair." };
  }

  start(): void {}

  stop(): void {
    this.#cancelReplay();
  }

  /** Every frame in order, each `afterMs` after the one before; a new replay cancels one still running. */
  resync(): void {
    this.#cancelReplay();
    this.#state = this.#file.state;
    if (this.#file.state.phase !== "live") return;
    let at = 0;
    for (const { afterMs, ...checked } of this.#file.frames) {
      at += afterMs ?? 0;
      // Fixtures are recorded hub frames, checked at the fields main relies on, like a live hub's.
      const play = checked.t === "rows" ? () => this.#rows(checked) : () => this.#emit(checked as HubFrame);
      if (at === 0) play();
      else this.#replay.push(setTimeout(play, at));
    }
  }

  call(request: CallRequest): Promise<CallOutcome> {
    const answer = this.#file.calls.find((c) => c.tool === request.tool && (c.input === undefined || matches(c.input, request.input)));
    if (answer === undefined) {
      const message = `fixture ${this.#file.name} has no answer for ${request.tool} ${JSON.stringify(request.input)}`;
      console.warn(message);
      return Promise.resolve({ ok: false, error: { code: "not_found", message } });
    }
    const outcome = echoRequestId(request, this.#withoutHidden(request.tool, answer.outcome));
    if (answer.then !== undefined) this.#apply(answer.then);
    if (answer.delayMs === undefined || answer.delayMs === 0) return Promise.resolve(outcome);
    return new Promise((resolve) => setTimeout(() => resolve(outcome), answer.delayMs));
  }

  #apply(then: z.infer<typeof Then>): void {
    this.#rows(then);
    let at = 0;
    for (const { afterMs, ...checked } of then.frames ?? []) {
      at += afterMs ?? 0;
      this.#replay.push(
        setTimeout(() => {
          if (checked.t === "rows") return this.#rows(checked);
          const frame = checked as HubFrame;
          this.#emit(frame.t === "event" ? { ...frame, event: { ...frame.event, seq: this.#seq + 1 } } : frame);
        }, at),
      );
    }
  }

  #rows({ hide, show }: { hide?: Array<z.infer<typeof Rows>> | undefined; show?: Array<z.infer<typeof Rows>> | undefined }): void {
    const same = (a: z.infer<typeof Rows>, b: z.infer<typeof Rows>) => JSON.stringify(a) === JSON.stringify(b);
    for (const rows of show ?? []) this.#hidden = this.#hidden.filter((h) => !same(h, rows));
    for (const rows of hide ?? []) if (!this.#hidden.some((h) => same(h, rows))) this.#hidden.push(rows);
  }

  #withoutHidden(tool: string, outcome: CallOutcome): CallOutcome {
    const hides = this.#hidden.filter((h) => h.tool === tool);
    if (!outcome.ok || hides.length === 0 || outcome.output === null || typeof outcome.output !== "object") return outcome;
    const output = { ...(outcome.output as Record<string, unknown>) };
    for (const { field, where } of hides) {
      const rows = output[field];
      if (Array.isArray(rows)) output[field] = rows.filter((row) => !matches(where, row));
    }
    return { ok: true, output };
  }

  chat(): void {}

  focus(): void {}

  presence(): void {}

  watch(session: string | null): void {
    this.#watch = session;
    const newest = session === null ? undefined : this.#frames.get(session);
    if (newest !== undefined) this.#out(newest);
  }

  input(): void {}

  refreshLive(): void {}

  // Retry now while waiting out a retry: the attempt starts and, with no hub behind a fixture, keeps running.
  reconnectNow(): void {
    const s = this.#state;
    if (s.phase !== "retrying") return;
    this.#state = { phase: "connecting", hub: s.hub, attempt: 1 };
    this.#emit({ t: "state", state: this.#state });
  }

  #cancelReplay(): void {
    for (const timer of this.#replay) clearTimeout(timer);
    this.#replay = [];
  }
}
