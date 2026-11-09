// Approved commands that outlive their link. A `gated_run` with a `requestId` runs
// to its end whatever happens to the link it came on, and its result is kept under its request in
// `<node home>/gated/<Q>.json` for the hub's `gated_resume`. A record still without a result after the node restarted
// says the command was cut off.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { runGated, type SecretsContext } from "../secrets/index.ts";
import { writeAtomic } from "../secrets/files.ts";
import type { GatedResult, GatedResume, GatedRun } from "../wire.ts";

/** How long a kept result stays: well past any hub restart or link drop it waits out. */
const KEEP_MS = 7 * 24 * 3600 * 1000;

type Record_ = { hubId: string; result: GatedResult | null };

export class GatedRuns {
  readonly #dir: string;
  readonly #running = new Map<string, Promise<GatedResult>>();
  constructor(
    nodeHome: string,
    readonly machineId: string,
  ) {
    this.#dir = join(nodeHome, "gated");
  }

  /** Runs `frame` for `hubId`, keeping its result under its request. A request running here already isn't started
   * twice: it answers with that run's result. */
  async run(frame: GatedRun, hubId: string, ctx: SecretsContext): Promise<GatedResult> {
    const request = frame.requestId;
    if (!request) return runGated(frame, ctx);
    const running = this.#running.get(request);
    if (running) return { ...(await running), id: frame.id };
    const done = (async () => {
      this.#prune();
      this.#write(request, { hubId, result: null });
      const result = await runGated(frame, ctx);
      this.#write(request, { hubId, result });
      return result;
    })();
    this.#running.set(request, done);
    try {
      return await done;
    } finally {
      this.#running.delete(request);
    }
  }

  /** `gated_resume`: the request's result, once it ends when it still runs; `unknown` says why there is none. */
  async resume(frame: GatedResume, hubId: string): Promise<GatedResult> {
    const running = this.#running.get(frame.requestId);
    if (running) return { ...(await running), id: frame.id };
    const record = this.#read(frame.requestId);
    if (record && record.hubId === hubId) {
      if (record.result) return { ...record.result, id: frame.id };
      return unknown(frame.id, `${this.machineId}'s node restarted while it ran, which ended it`);
    }
    return unknown(frame.id, `${this.machineId}'s node has no record of running it`);
  }

  #path(request: string) {
    return join(this.#dir, `${request}.json`);
  }

  #read(request: string): Record_ | undefined {
    try {
      return JSON.parse(readFileSync(this.#path(request), "utf8")) as Record_;
    } catch {
      return undefined;
    }
  }

  /** A failure costs only the result after a restart, so it is logged. */
  #write(request: string, record: Record_): void {
    try {
      mkdirSync(this.#dir, { recursive: true });
      writeAtomic(this.#path(request), JSON.stringify(record));
    } catch (error) {
      console.warn(`couldn't keep an approved command's result for ${request}: ${String(error)}`);
    }
  }

  #prune(): void {
    if (!existsSync(this.#dir)) return;
    for (const name of readdirSync(this.#dir)) {
      const path = join(this.#dir, name);
      try {
        if (Date.now() - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { force: true });
      } catch {}
    }
  }
}

const unknown = (id: string, why: string): GatedResult => ({ id, exitCode: null, outputTail: "", timedOut: false, unknown: why });
