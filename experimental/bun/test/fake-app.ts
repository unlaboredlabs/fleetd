// A stand-in app for /app tests: frames it gets, as values, and a wait for the next one that matches.
import { Inflater } from "../src/hub/link/deflate.ts";

export type Frame = { t: string; binary?: boolean } & Record<string, unknown>;

export class FakeApp {
  readonly ws: WebSocket;
  readonly frames: Frame[] = [];
  readonly opened: Promise<void>;
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  private inflater = new Inflater(64 << 20);
  private queue: Promise<void> = Promise.resolve();

  constructor(url: string, headers?: Record<string, string>) {
    this.ws = new WebSocket(url, headers ? ({ headers } as never) : undefined);
    this.ws.binaryType = "arraybuffer";
    this.opened = new Promise((resolve) => this.ws.addEventListener("open", () => resolve()));
    this.closed = new Promise((resolve) => this.ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason })));
    this.ws.addEventListener("message", (e) => {
      const data = e.data;
      this.queue = this.queue.then(async () => {
        const binary = typeof data !== "string";
        const text = binary ? await this.inflater.inflate(new Uint8Array(data as ArrayBuffer)) : (data as string);
        const frame = { ...(JSON.parse(text) as Frame), binary };
        this.frames.push(frame);
        this.waiters = this.waiters.filter((w) => (w.match(frame) ? (w.resolve(frame), false) : true));
      });
    });
  }

  async send(frame: unknown) {
    await this.opened;
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  /** The first frame, seen or to come, that `match` takes and no earlier `next` took. */
  next(match: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const i = this.frames.findIndex((f) => match(f) && !(f as { taken?: boolean }).taken);
    if (i >= 0) {
      const f = this.frames[i] as Frame;
      (f as { taken?: boolean }).taken = true;
      return Promise.resolve(f);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no such frame")), timeoutMs);
      this.waiters.push({
        match,
        resolve: (f) => {
          (f as { taken?: boolean }).taken = true;
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  tag(t: string, timeoutMs?: number) {
    return this.next((f) => f.t === t, timeoutMs);
  }

  close() {
    this.ws.close();
  }
}
