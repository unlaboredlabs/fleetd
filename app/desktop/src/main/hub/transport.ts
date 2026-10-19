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
  onPong(): void;
  onClose(code: number, reason: string, error?: SocketError): void;
}

export interface Connection {
  send(text: string): void;
  /** A WebSocket ping; the hub (axum) answers with a pong. */
  ping(): void;
  /** Drops the link at once, without waiting on a closing handshake a dead peer would never answer. */
  close(): void;
}

/** Opens one connection to a hub's /app socket URL. The real one is a WebSocket; tests use a fake. */
export type Transport = (url: string, events: ConnectionEvents) => Connection;

/** Node's built-in WebSocket can't ping, so `ws`. */
export const webSocketTransport: Transport = (url, events) => {
  trustSystemCAs();
  const socket = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
  let closed = false;
  let error: SocketError | undefined;
  const close = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    events.onClose(code, reason, error);
  };
  socket.on("open", () => events.onOpen());
  socket.on("message", (data, isBinary) => {
    if (!isBinary) events.onText(Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]).toString("utf8"));
  });
  socket.on("pong", () => events.onPong());
  // An error is always followed by close; the close carries the code, the error the cause.
  socket.on("error", (e: Error & { code?: unknown; errors?: ReadonlyArray<Error & { code?: unknown }> }) => {
    // A name with several addresses fails as an AggregateError; its first error has the code.
    const code = typeof e.code === "string" ? e.code : e.errors?.find((x) => typeof x.code === "string")?.code;
    error = { code: typeof code === "string" ? code : undefined, message: e.message || (e.errors?.[0]?.message ?? "") };
  });
  socket.on("close", (code, reason) => close(code, reason.toString("utf8")));
  return {
    send: (text) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
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
