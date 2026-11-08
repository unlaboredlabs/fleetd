// The /app socket's seam of D346 as this area uses it (T2253's src/hub/app_ws, #1186): `on(type, fn(conn, msg))`,
// `sendTo`, `broadcast`, `onClose`, `onPong`, and a connection's `caller` and `ws`. Nothing here registers an area
// (D354): browser/app.ts binds to whichever /app seam it is given (`bindApp`), the real one once #1186 is on main.
import type { Caller } from "../api/registry.ts";
import type { Socket } from "../http/route.ts";

/** The part of #1186's AppConn this area reads. */
export type AppConn = { caller: Caller | undefined; ws: Socket };
export type MessageHandler = (conn: AppConn, message: Record<string, unknown>) => unknown;

export interface AppWsArea {
  on(type: string, fn: MessageHandler): () => void;
  sendTo(conn: AppConn, msg: unknown): boolean;
  broadcast(msg: unknown): void;
  onClose(conn: AppConn, fn: () => void): () => void;
  onPong(fn: (conn: AppConn, data: Buffer) => void): () => void;
}

/** An in-memory /app for tests and benches, which drive it as app connections. */
export class ShimAppWs implements AppWsArea {
  readonly handlers = new Map<string, MessageHandler>();
  readonly closes = new Map<AppConn, Set<() => void>>();
  readonly pongs = new Set<(conn: AppConn, data: Buffer) => void>();
  readonly broadcasts: unknown[] = [];
  on(type: string, fn: MessageHandler): () => void {
    this.handlers.set(type, fn);
    return () => this.handlers.delete(type);
  }
  sendTo(conn: AppConn, msg: unknown): boolean {
    return conn.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg)) >= 0;
  }
  broadcast(msg: unknown): void {
    this.broadcasts.push(msg);
  }
  onClose(conn: AppConn, fn: () => void): () => void {
    const set = this.closes.get(conn) ?? new Set();
    set.add(fn);
    this.closes.set(conn, set);
    return () => set.delete(fn);
  }
  onPong(fn: (conn: AppConn, data: Buffer) => void): () => void {
    this.pongs.add(fn);
    return () => this.pongs.delete(fn);
  }
  /** A message from an app connection. */
  async deliver(conn: AppConn, msg: Record<string, unknown>): Promise<void> {
    await this.handlers.get(String(msg.t))?.(conn, msg);
  }
  close(conn: AppConn): void {
    for (const fn of this.closes.get(conn) ?? []) fn();
    this.closes.delete(conn);
  }
}
