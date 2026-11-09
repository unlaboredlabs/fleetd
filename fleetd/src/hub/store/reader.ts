// The main thread's side of the read workers: a few workers, each with its own read-only connection and answering its
// calls in order; a call goes to the one with the fewest waiting, so two long reads (the Time view's breakdown and
// insights) run side by side.
import { ToolError } from "../../shared/errors.ts";
import type { TimeJob } from "../time/reads.ts";
import type { Upkept, UpkeepJob } from "../time/upkeep.ts";
import type { Params } from "./db.ts";
import type { ReadReply, ReadRequest } from "./read-worker.ts";

/**
 * From source, the worker file beside this one. In a `bun build --compile` binary, which embeds it as an entry point
 * of its own (package.json `compile`, built with `--root .`), its path from the build's root.
 */
const WORKER = Bun.main.startsWith("/$bunfs/")
  ? "./src/hub/store/read-worker.ts"
  : new URL("./read-worker.ts", import.meta.url).href;

/** Read workers the hub keeps. */
export const READ_WORKERS = 2;

type Waiting = { resolve: (value: unknown) => void; reject: (e: Error) => void };
type Lane = { worker: Worker; waiting: Map<number, Waiting> };

export class Reader {
  private next = 0;
  private readonly lanes: Lane[] = [];

  constructor(path: string, workers = READ_WORKERS) {
    for (let i = 0; i < workers; i++) {
      const lane: Lane = { worker: new Worker(WORKER), waiting: new Map() };
      lane.worker.onmessage = (event: MessageEvent<ReadReply>) => {
        const reply = event.data;
        const call = lane.waiting.get(reply.id);
        lane.waiting.delete(reply.id);
        if (lane.waiting.size === 0) lane.worker.unref();
        if ("error" in reply) {
          const t = reply.tool;
          call?.reject(t ? new ToolError(t.code, t.message, t.fix, t.reason, t.personFix) : new Error(`hub db read: ${reply.error}`));
        } else call?.resolve("rows" in reply ? reply.rows : reply.output);
      };
      lane.worker.onerror = (event) => {
        for (const call of lane.waiting.values()) call.reject(new Error(`hub db read worker: ${event.message}`));
        lane.waiting.clear();
      };
      lane.worker.postMessage({ id: -1, path } satisfies ReadRequest);
      lane.worker.unref();
      this.lanes.push(lane);
    }
  }

  all<T>(sql: string, params: Params): Promise<T[]> {
    return this.send((id) => ({ id, sql, params })) as Promise<T[]>;
  }

  /** A Time read answered whole on a worker (time/reads.ts); a refusal comes back as its ToolError. */
  time(job: TimeJob): Promise<unknown> {
    return this.send((id) => ({ id, time: job }));
  }

  /** The Time digests' upkeep, worked out on a worker for the hub thread to store (time/upkeep.ts). */
  upkeep(job: UpkeepJob): Promise<Upkept> {
    return this.send((id) => ({ id, upkeep: job })) as Promise<Upkept>;
  }

  private send(request: (id: number) => ReadRequest): Promise<unknown> {
    const id = this.next++;
    const lane = this.lanes.reduce((a, b) => (b.waiting.size < a.waiting.size ? b : a));
    return new Promise((resolve, reject) => {
      lane.waiting.set(id, { resolve, reject });
      lane.worker.ref();
      lane.worker.postMessage(request(id));
    });
  }

  close(): void {
    for (const lane of this.lanes) lane.worker.terminate();
  }
}
