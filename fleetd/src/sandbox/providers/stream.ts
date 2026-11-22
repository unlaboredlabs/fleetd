// One private port of a hosted box as a duplex byte stream: a WebSocket through the provider's proxy, with the
// provider's access header and fleetd's own per-box secret. Binary frames carry raw bytes; the node's mux
// (sandbox/mux) frames its channels inside and wraps this with `Duplex.fromWeb`. A dropped link ends `closed` and the
// mux dials again: the session host's acks and resends cover what was in flight.
import { ProviderError, scrub } from "./http.ts";

export type Duplex = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  /** Resolves when the link ends, by either side. */
  closed: Promise<void>;
  close(): void;
  /** Sends one text message, outside the byte stream (the hosted bootstrap's control words). */
  sendText(text: string): void;
};

/** Bytes buffered for sending past which a write waits. */
const HIGH_WATER = 1 << 20;
/** How long a dial may take to open. */
export const DIAL_MS = 30_000;

export type Dial = {
  /** The provider's name in messages. */
  name: string;
  url: string;
  headers: Record<string, string>;
  /** Cut out of any message: the provider's access token and fleetd's secret. */
  secrets: string[];
  signal?: AbortSignal;
  WebSocket?: typeof WebSocket;
};

/** Opens the WebSocket; refuses in plain words when it doesn't open. */
export function dial(d: Dial): Promise<Duplex> {
  const WS = d.WebSocket ?? WebSocket;
  const url = d.url.replace(/^http/, "ws");
  return new Promise((resolve, reject) => {
    // Bun's client takes headers; the browser's constructor doesn't, which never runs here.
    const ws = new (WS as any)(url, { headers: d.headers }) as WebSocket;
    ws.binaryType = "arraybuffer";
    let open = false;
    let end: () => void = () => {};
    const closed = new Promise<void>((r) => (end = r));
    let pull: ReadableStreamDefaultController<Uint8Array> | undefined;
    const timer = setTimeout(() => fail(`it didn't open within ${DIAL_MS / 1000} seconds`), DIAL_MS);
    const abort = () => fail("cancelled");
    d.signal?.addEventListener("abort", abort, { once: true });

    /** `why` in fleetd's own words; `said`, the far end's, for the log only. */
    function fail(why: string, said?: string) {
      if (open) return;
      clearTimeout(timer);
      d.signal?.removeEventListener("abort", abort);
      try {
        ws.close();
      } catch {}
      reject(new ProviderError("unreachable", `couldn't open the link to the box at ${d.name}: ${why}`, undefined, undefined, said));
    }

    ws.onopen = () => {
      open = true;
      clearTimeout(timer);
      d.signal?.removeEventListener("abort", abort);
      const readable = new ReadableStream<Uint8Array>({
        start(c) {
          pull = c;
        },
        cancel() {
          ws.close();
        },
      });
      const writable = new WritableStream<Uint8Array>({
        async write(chunk) {
          if (ws.readyState !== WebSocket.OPEN) throw new Error("the link to the box is closed");
          ws.send(chunk);
          while (ws.bufferedAmount > HIGH_WATER && ws.readyState === WebSocket.OPEN) await Bun.sleep(5);
        },
        close() {
          ws.close();
        },
        abort() {
          ws.close();
        },
      });
      resolve({ readable, writable, closed, close: () => ws.close(), sendText: (t) => ws.send(t) });
    };
    // A WebSocket can't be paused, so what arrives is queued as it comes: the mux's windows (node/sandbox/mux.ts, 256
    // KiB a channel) bound how much of it is ever in flight.
    ws.onmessage = (e: MessageEvent) => {
      const data = e.data;
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer);
      try {
        pull?.enqueue(bytes);
      } catch {}
    };
    ws.onerror = () => fail("the provider refused it or the box isn't listening");
    ws.onclose = (e: CloseEvent) => {
      if (!open) return fail(`it closed with code ${e.code}`, e.reason ? scrub(e.reason, d.secrets[0] ?? "", 160) : undefined);
      try {
        pull?.close();
      } catch {}
      end();
    };
  });
}
