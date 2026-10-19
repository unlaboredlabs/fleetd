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

const FixtureFile = z.object({
  version: z.literal(1),
  name: z.string(),
  note: z.string(),
  now: z.iso.datetime({ offset: true }),
  state: z.discriminatedUnion("phase", [
    z.object({ phase: z.literal("unpaired"), note: z.string().optional() }),
    z.object({ phase: z.literal("connecting"), hub: z.string(), attempt: z.int().min(0) }),
    z.object({ phase: z.literal("live"), hub: z.string(), protocol: z.int() }),
    z.object({ phase: z.literal("retrying"), hub: z.string(), reason: z.string(), retryAt: z.number() }),
    z.object({ phase: z.literal("refused"), hub: z.string(), message: z.string() }),
  ]),
  frames: z.array(
    z.discriminatedUnion("t", [
      z.object({ t: z.literal("snapshot"), snapshot: z.looseObject({ cursor: z.int().min(0) }), afterMs: delay }),
      z.object({ t: z.literal("event"), event: z.looseObject({ seq: z.int().min(0), type: z.string() }), afterMs: delay }),
      z.object({ t: z.literal("live"), frame: z.looseObject({ full: z.boolean() }), afterMs: delay }),
      z.object({ t: z.literal("error"), error: hubError, afterMs: delay }),
    ]),
  ),
  calls: z.array(
    z.object({
      tool: z.string(),
      input: z.json().optional(),
      outcome: z.union([z.object({ ok: z.literal(true), output: z.json() }), z.object({ ok: z.literal(false), error: hubError })]),
      delayMs: delay,
    }),
  ),
  connect: z.union([z.object({ ok: z.literal(true) }), z.object({ ok: z.literal(false), message: z.string() })]).optional(),
});
export type FixtureFile = z.infer<typeof FixtureFile>;

/** Set alongside FLEETD_FIXTURE to use a fixture in a packaged build (a QA run of the release app). */
export const ALLOW_PACKAGED = "FLEETD_DEV_FIXTURES";

/**
 * Which fixture, if any, replaces the hub. A packaged app ignores a stray FLEETD_FIXTURE (fake data must never pass
 * for a real hub) unless FLEETD_DEV_FIXTURES=1 is set too.
 */
export const fixtureRequest = (
  vars: NodeJS.ProcessEnv,
  packaged: boolean,
): { kind: "none" } | { kind: "ignored"; reason: string } | { kind: "fixture"; name: string } => {
  const name = vars["FLEETD_FIXTURE"];
  if (name === undefined || name === "") return { kind: "none" };
  if (packaged && vars[ALLOW_PACKAGED] !== "1") {
    return { kind: "ignored", reason: `FLEETD_FIXTURE is ignored in a packaged app unless ${ALLOW_PACKAGED}=1 is set too.` };
  }
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

export class FixtureSource implements HubSource {
  readonly #file: FixtureFile;
  readonly #emit: (frame: HubFrame) => void;
  #replay: Array<ReturnType<typeof setTimeout>> = [];

  constructor(file: FixtureFile, emit: (frame: HubFrame) => void) {
    this.#file = file;
    this.#emit = emit;
  }

  get state(): HubState {
    return this.#file.state;
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
    if (this.#file.state.phase !== "live") return;
    let at = 0;
    for (const { afterMs, ...checked } of this.#file.frames) {
      // Fixtures are recorded hub frames, checked at the fields main relies on, like a live hub's.
      const frame = checked as HubFrame;
      at += afterMs ?? 0;
      if (at === 0) this.#emit(frame);
      else this.#replay.push(setTimeout(() => this.#emit(frame), at));
    }
  }

  call(request: CallRequest): Promise<CallOutcome> {
    const answer = this.#file.calls.find((c) => c.tool === request.tool && (c.input === undefined || matches(c.input, request.input)));
    if (answer === undefined) {
      const message = `fixture ${this.#file.name} has no answer for ${request.tool} ${JSON.stringify(request.input)}`;
      console.warn(message);
      return Promise.resolve({ ok: false, error: { code: "not_found", message } });
    }
    const outcome: CallOutcome = answer.outcome;
    if (answer.delayMs === undefined || answer.delayMs === 0) return Promise.resolve(outcome);
    return new Promise((resolve) => setTimeout(() => resolve(outcome), answer.delayMs));
  }

  live(): void {}

  refreshLive(): void {}

  reconnectNow(): void {}

  #cancelReplay(): void {
    for (const timer of this.#replay) clearTimeout(timer);
    this.#replay = [];
  }
}
