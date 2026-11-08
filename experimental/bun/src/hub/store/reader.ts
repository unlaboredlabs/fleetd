// The main thread's side of the read worker: one worker, one read-only connection, calls answered in order.
import type { Params } from "./db.ts";
import type { ReadReply, ReadRequest } from "./read-worker.ts";

/**
 * From source, the worker file beside this one. In a `bun build --compile` binary, which embeds it as an entry point
 * of its own (package.json `compile`, built with `--root .`), its path from the build's root.
 */
const WORKER = Bun.main.startsWith("/$bunfs/")
  ? "./src/hub/store/read-worker.ts"
  : new URL("./read-worker.ts", import.meta.url).href;

export class Reader {
  private readonly worker: Worker;
  private next = 0;
  private readonly waiting = new Map<number, { resolve: (rows: never[]) => void; reject: (e: Error) => void }>();

  constructor(path: string) {
    this.worker = new Worker(WORKER);
    this.worker.onmessage = (event: MessageEvent<ReadReply>) => {
      const reply = event.data;
      const call = this.waiting.get(reply.id);
      this.waiting.delete(reply.id);
      if (this.waiting.size === 0) this.worker.unref();
      if ("error" in reply) call?.reject(new Error(`hub db read: ${reply.error}`));
      else call?.resolve(reply.rows as never[]);
    };
    this.worker.onerror = (event) => {
      for (const call of this.waiting.values()) call.reject(new Error(`hub db read worker: ${event.message}`));
      this.waiting.clear();
    };
    this.worker.postMessage({ id: -1, path } satisfies ReadRequest);
    this.worker.unref();
  }

  all<T>(sql: string, params: Params): Promise<T[]> {
    const id = this.next++;
    return new Promise<T[]>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (rows: never[]) => void, reject });
      this.worker.ref();
      this.worker.postMessage({ id, sql, params } satisfies ReadRequest);
    });
  }

  close(): void {
    this.worker.terminate();
  }
}
