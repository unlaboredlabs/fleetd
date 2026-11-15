// What a hub connection is to the client (client.ts), whatever carries it: Node's `ws` in main (transport.ts), the
// browser's WebSocket in the web app (src/web/hub.ts), a fake in tests. No Node here, so the web app types against it.
import type { SocketError } from "./explain";

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
