import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { LookupFunction, Socket } from "node:net";
import { constants, createInflateRaw, deflateRawSync, type InflateRaw } from "node:zlib";
import WebSocket from "ws";
import type { SocketError } from "./explain";
import { trustSystemCAs } from "../trust";

/**
 * What a connection reports. `onClose` comes exactly once, also after a failed connect (code 1006); `error` is the
 * socket error before it, which says why (refused, not found, TLS…) where the code can't.
 */
export interface ConnectionEvents {
  onOpen(): void;
  onText(text: string): void;
  /** Anything came: a pong, the hub's own ping, or the bytes of a frame still arriving. The link is alive. */
  onHeard(): void;
  onClose(code: number, reason: string, error?: SocketError): void;
}

export interface Connection {
  /** A frame as Text, or with `compress` as a Binary the hub inflates (only once its `ready` listed `deflate`). */
  send(text: string, compress?: boolean): void;
  /** A WebSocket ping; the hub (axum) answers with a pong. */
  ping(): void;
  /** Drops the link at once, without waiting on a closing handshake a dead peer would never answer. */
  close(): void;
}

/**
 * Opens one connection to a hub's /app socket URL, `headers` on its upgrade request. The real one is a WebSocket; tests
 * use a fake.
 */
export type Transport = (url: string, events: ConnectionEvents, headers?: Readonly<Record<string, string>>) => Connection;

/** The most one compressed frame may inflate to, as the hub's own cap. */
export const INFLATE_MAX_BYTES = 64 * 1024 * 1024;
const SYNC_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

/**
 * One frame as the hub inflates the app's: raw DEFLATE, sync-flushed with its 00 00 ff ff cut off, at the fastest
 * level (an upload's piece is base64, which deflates to three quarters at any level). Each message is a stream of its
 * own that never looks back, so the hub's one inflater per connection reads it whatever came before.
 */
export const deflated = (text: string): Buffer => {
  const out = deflateRawSync(Buffer.from(text, "utf8"), { level: 1, finishFlush: constants.Z_SYNC_FLUSH });
  return out.subarray(0, out.length - SYNC_TAIL.length);
};

/**
 * A hub that read `deflate` in the auth sends frames as Binary: permessage-deflate (RFC 7692), one raw DEFLATE stream
 * per connection with its context kept, each message sync-flushed with its 00 00 ff ff cut off. So one inflater per
 * connection, each message's text read after its own flush; `inflateRawSync` would lose the context between them.
 */
export const inflater = (): ((data: Buffer) => Promise<string>) => {
  let stream: InflateRaw | null = null;
  return (data) =>
    new Promise((resolve, reject) => {
      stream ??= createInflateRaw({ windowBits: 15 });
      const s = stream;
      const chunks: Buffer[] = [];
      let size = 0;
      let failed = false;
      const fail = (error: Error) => {
        if (failed) return;
        failed = true;
        s.off("data", onData);
        s.off("error", fail);
        reject(error);
      };
      const onData = (chunk: Buffer) => {
        size += chunk.length;
        if (size > INFLATE_MAX_BYTES) fail(new Error("a compressed frame inflated past its cap"));
        else chunks.push(chunk);
      };
      s.on("data", onData);
      s.on("error", fail);
      s.write(Buffer.concat([data, SYNC_TAIL]));
      s.flush(constants.Z_SYNC_FLUSH, () => {
        if (failed) return;
        s.off("data", onData);
        s.off("error", fail);
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
};

type Resolve = (hostname: string, options: { family: number; hints?: number | undefined }, done: (error: Error | null, addresses: LookupAddress[]) => void) => void;

const resolveAll: Resolve = (hostname, options, done) => dnsLookup(hostname, { ...options, all: true }, done);

/**
 * A lookup that runs one getaddrinfo per name at a time: a dial while one runs takes its answer. getaddrinfo can't be
 * called off and holds one of libuv's four threads until it gives up, which a resolver that doesn't answer (a tailnet's
 * just after a wake) makes half a minute: a dial a second would fill the pool, and every file read in main wait behind.
 */
export const sharedLookup = (resolve: Resolve = resolveAll): LookupFunction => {
  const running = new Map<string, Promise<LookupAddress[]>>();
  return (hostname, options, callback) => {
    const family = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : (options.family ?? 0);
    const key = `${hostname} ${String(family)}`;
    let answer = running.get(key);
    if (answer === undefined) {
      const asked = new Promise<LookupAddress[]>((ok, fail) => {
        resolve(hostname, { family, hints: options.hints }, (error, addresses) => (error === null ? ok(addresses) : fail(error)));
      });
      answer = asked;
      running.set(key, asked);
      const done = () => {
        if (running.get(key) === asked) running.delete(key);
      };
      asked.then(done, done);
    }
    answer.then(
      (addresses) => {
        const first = addresses[0];
        if (options.all === true) callback(null, addresses);
        else if (first === undefined) callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }), "");
        else callback(null, first.address, first.family);
      },
      (error: unknown) => callback(error as NodeJS.ErrnoException, ""),
    );
  };
};

const lookup = sharedLookup();

/** Node's built-in WebSocket can't ping, so `ws`. */
export const webSocketTransport: Transport = (url, events, headers) => {
  if (url.startsWith("wss:")) trustSystemCAs();
  const socket = new WebSocket(url, { maxPayload: 64 * 1024 * 1024, lookup, ...(headers === undefined ? {} : { headers: { ...headers } }) });
  let closed = false;
  let error: SocketError | undefined;
  const inflate = inflater();
  /** Frames reach the client in the order they came: a Text frame waits for the Binary ones before it to inflate. */
  let inflating: Promise<void> | null = null;
  let behind = 0;
  const deliver = (bytes: Buffer, isBinary: boolean) => {
    if (!isBinary && inflating === null) {
      events.onText(bytes.toString("utf8"));
      return;
    }
    behind++;
    // One inflation at a time: each reads the inflater's output up to its own flush.
    inflating = (inflating ?? Promise.resolve())
      .then(() => (isBinary ? inflate(bytes) : bytes.toString("utf8")))
      .then(
        (text) => {
          if (!closed) events.onText(text);
        },
        (e: unknown) => {
          // A frame that won't inflate leaves the stream unreadable from here: drop the link, the client dials again.
          error = { code: undefined, message: e instanceof Error ? e.message : String(e) };
          socket.terminate();
          close(1006, "a compressed frame didn't inflate");
        },
      )
      .finally(() => {
        if (--behind === 0) inflating = null;
      });
  };
  const close = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    events.onClose(code, reason, error);
  };
  // Bytes, not whole frames: a large one taking seconds on a slow link is the link at work, not a silent one. Heard
  // from `open` on, once `ws` reads the socket itself: a listener before that would take its first frames.
  let raw: Socket | undefined;
  socket.on("upgrade", (response) => (raw = response.socket));
  socket.on("open", () => {
    raw?.on("data", () => events.onHeard());
    events.onOpen();
  });
  socket.on("message", (data, isBinary) => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
    deliver(bytes, isBinary);
  });
  socket.on("ping", () => events.onHeard());
  // An error is always followed by close; the close carries the code, the error the cause.
  socket.on("error", (e: Error & { code?: unknown; errors?: ReadonlyArray<Error & { code?: unknown }> }) => {
    // A name with several addresses fails as an AggregateError; its first error has the code.
    const code = typeof e.code === "string" ? e.code : e.errors?.find((x) => typeof x.code === "string")?.code;
    error = { code: typeof code === "string" ? code : undefined, message: e.message || (e.errors?.[0]?.message ?? "") };
  });
  socket.on("close", (code, reason) => close(code, reason.toString("utf8")));
  return {
    send: (text, compress = false) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(compress ? deflated(text) : text, { binary: compress });
    },
    ping: () => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    },
    close: () => {
      socket.terminate();
      close(1006, "closed by the app");
    },
  };
};
