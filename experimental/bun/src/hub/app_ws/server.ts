// The app WebSocket at /app (crates/fleetd/src/hub/app_ws/mod.rs): `auth` with a key, then `snapshot` for the
// fleetd_status data, `events` to stream HubEvents after a cursor as they happen, `call` to run any MCP tool with the
// connection's key through the same registry, grants and limits as /mcp, and `presence`, recorded and never
// answered. The other client messages (`chat`, `live`, `browser_*`, `screen_thumbs`) are their areas', through `on`.
//
// `hub.area("app_ws")` is the seam (D346): `on(type, fn(conn, msg))`, `sendTo(conn, msg)`, `broadcast(msg)`,
// `onClose(conn, fn)`.
//
// The event stream is pushed, not polled: each appended event is serialized once and written to every streaming
// connection that may read it. A connection that falls behind (more than MAX_QUEUED_BYTES unsent) leaves the push and
// reads from its cursor out of the log once its socket drains, so a slow client still gets every event, in order.
import type { ServerWebSocket } from "bun";
import { APP_CLOSE_RESTART, type AppClientMessage, type HubEvent, PROTOCOL_VERSION } from "../../shared/contracts.ts";
import { internalError, ToolError } from "../../shared/errors.ts";
import { VERSION } from "../../shared/version.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import type { SocketData } from "../http/route.ts";
import { Deflater, Inflater, MIN_DEFLATE_BYTES } from "../link/deflate.ts";
import { record as recordPresence } from "../metrics/presence.ts";
import { register as registerLive } from "./live/index.ts";
import { events } from "../store/events.ts";
import type { Updates } from "../update/index.ts";
import { type Others, others, visible } from "./visible.ts";

/** Close code for a connection whose key was refused. */
export const CLOSE_UNAUTHORIZED = 4401;
/** Calls one connection may have running at once; more are refused rather than queued without bound. */
export const MAX_CALLS_IN_FLIGHT = 32;
/**
 * "Going Away" (`APP_CLOSE_RESTART`): the hub is stopping and comes back within a moment; the reason says when an
 * update restarts it. Not 1012, as node links close: iOS's WebSocket refuses that code, and drops the reason with it.
 */
const CLOSE_RESTART = APP_CLOSE_RESTART;
/** `CLOSE_RESTART`'s reason when no update restarts the hub. */
const RESTARTING = "hub restarting";
/** "Try again later": the connection fell too far behind; the app reconnects and reads again. */
const CLOSE_TOO_FAR_BEHIND = 1013;
/** "Invalid frame payload data": a compressed frame that doesn't inflate. */
const CLOSE_BAD_DATA = 1007;
const MAX_INFLATED = 64 << 20;
/** After this long without a frame to the app, the hub pings it, so an idle NAT keeps the flow. */
export const KEEPALIVE_MS = 25_000;
/** How often a connection checks its key again with no revoke on this hub to wake it. */
const KEY_RECHECK_MS = 15_000;
/** Bytes one connection may have waiting for its socket (app_ws/outbox.rs `MAX_QUEUED_BYTES`). */
export const MAX_QUEUED_BYTES = 8 << 20;
/** Bytes per connection per second shared by the live feed and status answers (live.rs `MAX_BYTES_PER_SEC`). */
export const MAX_BYTES_PER_SEC = 32 * 1024;

/** The client messages the hub reads beyond the base set (contracts app.rs `APP_FEATURES`). */
export const APP_FEATURES = [
  "presence",
  "browser_sessions",
  "navi_asks",
  "screen_open",
  "navi_skills",
  "browser_navigate",
  "screen_thumbs",
  "artifacts",
  "agent_messages",
  "deflate",
  "frame_acks",
] as const;
export const APP_DEFLATE = "deflate";
/** The upgrade's `auth`: the key as `Authorization: Bearer`, the features comma-separated in this header. */
export const APP_FEATURES_HEADER = "x-fleetd-features";

/** The client messages, and which area answers each one not served here. */
const OWNERS: Record<string, string> = {
  chat: "src/hub/chat",
  live: "src/hub/app_ws/live",
  browser_watch: "src/hub/browser",
  browser_frame_ack: "src/hub/browser",
  browser_input: "src/hub/browser",
  screen_thumbs: "src/hub/browser",
};

export type AppMessage = AppClientMessage & Record<string, unknown>;

/** The upgrade request's own auth. */
export type EarlyAuth = { key: string; features: string[] };

/** One /app connection, as handlers of `on` see it. */
export class AppConn {
  /** The connection's key and who it is, once it authed. */
  key: string | undefined;
  caller: Caller | undefined;
  deflate = false;
  closed = false;
  /** The event stream: where it is, and whether it rides the push or reads its backlog. */
  stream: { cursor: number; live: boolean; generation: number; navis?: { at: number; set: Others } } | undefined;
  calls = 0;
  lastSent = 0;
  /** What the upgrade's auth answered before the frames came. */
  early: "none" | "auth" | "snapshot" = "none";
  readonly closeHooks = new Set<() => void>();
  deflater: Deflater | undefined;
  inflater: Inflater | undefined;
  /** Frames in, one at a time (an inflate is async), and out, in order once compressed. */
  inbox: Promise<void> = Promise.resolve();
  outbox: Promise<void> = Promise.resolve();
  /** Writes waiting for the socket to drain. */
  drained: (() => void)[] = [];
  /** live.rs `ConnBudget`: this second's start and the bytes spent in it. */
  budget = { second: 0, bytes: 0 };
  timers: Timer[] = [];
  /** Per-type "not ported" said once. */
  readonly told = new Set<string>();

  constructor(readonly ws: ServerWebSocket<SocketData>) {}

  /** Bytes the socket hasn't taken yet. */
  buffered(): number {
    return this.ws.getBufferedAmount();
  }

  /** Whether this second of the connection's budget still has room. */
  room(now: number): boolean {
    if (now - this.budget.second >= 1000) this.budget = { second: now, bytes: 0 };
    return this.budget.bytes < MAX_BYTES_PER_SEC;
  }

  spend(now: number, bytes: number): void {
    if (now - this.budget.second >= 1000) this.budget = { second: now, bytes: 0 };
    this.budget.bytes += bytes;
  }

  /**
   * Reserves `bytes` of this second's budget when they fit (or the second is still empty), returning 0; otherwise
   * the milliseconds until the next second.
   */
  reserve(now: number, bytes: number): number {
    if (now - this.budget.second >= 1000) this.budget = { second: now, bytes: 0 };
    if (this.budget.bytes === 0 || this.budget.bytes + bytes <= MAX_BYTES_PER_SEC) {
      this.budget.bytes += bytes;
      return 0;
    }
    return Math.max(1, this.budget.second + 1000 - now);
  }
}

/** The `error` frame for `error`, with the frame's `id` when it answers one. */
export function errorFrame(error: ToolError, id?: string): Record<string, unknown> {
  const frame: Record<string, unknown> = { t: "error" };
  if (id !== undefined) frame.id = id;
  frame.code = error.code;
  frame.message = error.message;
  if (error.fix !== undefined) frame.fix = error.fix;
  if (error.reason !== undefined) frame.reason = error.reason;
  return frame;
}

/** A ProjectRef as the contracts decode one: a machine slug and a non-empty project id. */
const isProjectRef = (v: unknown) =>
  !!v &&
  typeof v === "object" &&
  typeof (v as { machineId?: unknown }).machineId === "string" &&
  /^[a-z0-9-]{1,32}$/.test((v as { machineId: string }).machineId) &&
  typeof (v as { projectId?: unknown }).projectId === "string" &&
  (v as { projectId: string }).projectId !== "";

const validCallId = (id: unknown): id is string => typeof id === "string" && id.length >= 1 && id.length <= 64;

/** The client frame, checked for what its type needs; undefined for one that doesn't decode. */
function readMessage(text: string): { message?: AppMessage; id?: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const m = v as Record<string, unknown>;
  const id = validCallId(m.id) ? m.id : undefined;
  const ok = (() => {
    switch (m.t) {
      case "auth":
        return typeof m.key === "string" && (m.features === undefined || (Array.isArray(m.features) && m.features.every((f) => typeof f === "string")));
      case "snapshot":
        return true;
      case "events":
        return typeof m.cursor === "number" && Number.isInteger(m.cursor) && m.cursor >= 0;
      case "call":
        return validCallId(m.id) && typeof m.tool === "string";
      case "presence":
        return typeof m.focused === "boolean" && typeof m.input === "boolean" && (m.project === undefined || isProjectRef(m.project));
      case "live":
        return typeof m.board === "boolean";
      case undefined:
        return false;
      default:
        return typeof m.t === "string" && m.t in OWNERS;
    }
  })();
  return ok ? { message: m as AppMessage, ...(id === undefined ? {} : { id }) } : { ...(id === undefined ? {} : { id }) };
}

/** A client message's handler: the connection (authed) and the message. */
export type MessageHandler = (conn: AppConn, message: AppMessage) => unknown;

/** The hub's /app connections: `appWs(hub)` names it. */
export const appWs = (hub: Hub) => hub.area("app_ws", (h) => new AppWs(h));

export class AppWs {
  private readonly conns = new Set<AppConn>();
  private readonly handlers = new Map<string, MessageHandler>();
  private readonly pongHooks = new Set<(conn: AppConn, data: Buffer) => void>();
  private unsubscribe: (() => void) | undefined;
  private generation = 0;
  timings = { keepaliveMs: KEEPALIVE_MS, recheckMs: KEY_RECHECK_MS };

  /** The tool registry calls and snapshots go through; the route sets it (the registry isn't the hub's). */
  tools: Registry | undefined;

  constructor(private readonly hub: Hub) {
    hub.auth.onRevoke(() => {
      for (const conn of this.conns) this.recheck(conn);
    });
    hub.shutdown.signal.addEventListener("abort", () => {
      // A stop an update asked for says so, read as the hub stops: its `hub.update` event may not reach the app first.
      const reason = this.hub.peek<Updates>("updates")?.restartReason() ?? RESTARTING;
      for (const conn of [...this.conns]) this.close(conn, CLOSE_RESTART, reason);
    });
    registerLive(hub, this);
  }

  // ---- The seam (D346).

  /** Serves client messages of `type` (one handler per type); returns the unregister. */
  on(type: string, fn: MessageHandler): () => void {
    this.handlers.set(type, fn);
    return () => {
      if (this.handlers.get(type) === fn) this.handlers.delete(type);
    };
  }

  /**
   * Sends `msg` (an object, or its JSON text) to one connection, as a frame pushed as it happens: a connection with
   * more than MAX_QUEUED_BYTES unsent is too far behind and closes. False when it is gone or closed so.
   */
  sendTo(conn: AppConn, msg: unknown): boolean {
    if (conn.closed) return false;
    if (conn.buffered() > MAX_QUEUED_BYTES) {
      this.tooFarBehind(conn);
      return false;
    }
    this.write(conn, typeof msg === "string" ? msg : JSON.stringify(msg));
    return true;
  }

  /** Sends `msg` to every authed connection, serialized once. */
  broadcast(msg: unknown): void {
    const text = typeof msg === "string" ? msg : JSON.stringify(msg);
    for (const conn of this.conns) if (conn.caller) this.sendTo(conn, text);
  }

  /** Calls `fn` once when `conn` ends (any way); returns the unregister. */
  onClose(conn: AppConn, fn: () => void): () => void {
    conn.closeHooks.add(fn);
    return () => conn.closeHooks.delete(fn);
  }

  /** Hears each pong a connection's client sends (browser/app.ts paces live screens by them). */
  onPong(fn: (conn: AppConn, data: Buffer) => void): () => void {
    this.pongHooks.add(fn);
    return () => this.pongHooks.delete(fn);
  }

  /** Sends one frame that the client asked for: waits for room rather than closing a slow connection. */
  async sendAnswer(conn: AppConn, text: string): Promise<boolean> {
    while (!conn.closed && conn.buffered() > MAX_QUEUED_BYTES) await new Promise<void>((r) => conn.drained.push(r));
    if (conn.closed) return false;
    this.write(conn, text);
    return true;
  }

  /** The open, authed connections. */
  connections(): AppConn[] {
    return [...this.conns].filter((c) => c.caller);
  }

  // ---- The socket.

  /** The handler `GET /app` upgrades to; `early` is the upgrade's own auth. */
  socket(early: EarlyAuth | undefined) {
    return {
      open: (ws: ServerWebSocket<SocketData>) => this.open(ws, early),
      message: (ws: ServerWebSocket<SocketData>, message: string | Buffer) => this.message(ws.data.state as AppConn, message),
      close: (ws: ServerWebSocket<SocketData>) => this.closed(ws.data.state as AppConn),
      drain: (ws: ServerWebSocket<SocketData>) => this.drain(ws.data.state as AppConn),
      pong: (ws: ServerWebSocket<SocketData>, data: Buffer) => {
        const conn = ws.data.state as AppConn;
        for (const fn of this.pongHooks) fn(conn, data);
      },
    };
  }

  private write(conn: AppConn, text: string): void {
    conn.lastSent = Date.now();
    const deflater = conn.deflater;
    if (!deflater) {
      conn.ws.send(text);
      return;
    }
    conn.outbox = conn.outbox.then(async () => {
      // Written before a close (a refusal), it still goes out ahead of the close; once the socket is gone, nothing.
      if (conn.ws.readyState !== 1) return;
      if (text.length < MIN_DEFLATE_BYTES) conn.ws.send(text);
      else conn.ws.send(await deflater.deflate(text));
    });
  }

  private close(conn: AppConn, code: number, reason: string): void {
    if (conn.closed) return;
    const ws = conn.ws;
    void conn.outbox.then(() => ws.close(code, reason));
    this.closed(conn);
  }

  private tooFarBehind(conn: AppConn): void {
    console.warn(`an app connection stopped reading (${conn.buffered()} bytes waiting): closed it, the app reconnects and reads again`);
    this.close(conn, CLOSE_TOO_FAR_BEHIND, "it stopped reading what the hub sent");
  }

  private open(ws: ServerWebSocket<SocketData>, early: EarlyAuth | undefined): void {
    const conn = new AppConn(ws);
    ws.data.state = conn;
    this.conns.add(conn);
    conn.lastSent = Date.now();
    conn.timers.push(
      setInterval(() => {
        if (Date.now() - conn.lastSent >= this.timings.keepaliveMs) {
          conn.lastSent = Date.now();
          ws.ping();
        }
      }, Math.max(10, Math.min(this.timings.keepaliveMs, 1000))),
      setInterval(() => this.recheck(conn), this.timings.recheckMs),
    );
    if (early) {
      let caller: Caller | undefined;
      try {
        caller = this.hub.auth.verify(early.key);
      } catch {}
      // A refused key is only ignored: the client's `auth` frame is refused as always.
      if (caller) {
        this.ready(conn, early.key, caller, early.features);
        conn.early = "auth";
        void this.snapshot(conn, caller);
      }
    }
  }

  private ready(conn: AppConn, key: string, caller: Caller, features: string[]): void {
    conn.key = key;
    conn.caller = caller;
    const deflate = !conn.deflate && features.includes(APP_DEFLATE);
    conn.deflate ||= deflate;
    this.write(conn, JSON.stringify({ t: "ready", protocol: PROTOCOL_VERSION, version: VERSION, features: APP_FEATURES }));
    // `ready` goes as Text; everything after may come compressed.
    if (deflate) {
      conn.deflater = new Deflater();
      conn.inflater = new Inflater(MAX_INFLATED);
    }
  }

  /**
   * Checks the connection's key as it is now: true when it was refused since it authed (the refusal is sent first).
   * Otherwise the caller it verifies as replaces the connection's, so a changed role or grant holds from the next
   * frame on, as the Rust hub verifies each call's key. A check that failed any other way keeps the connection.
   */
  private keyRefused(conn: AppConn): boolean {
    if (!conn.key) return false;
    try {
      conn.caller = this.hub.auth.verify(conn.key);
      return false;
    } catch (error) {
      if (!(error instanceof ToolError)) return false;
      this.write(conn, JSON.stringify(errorFrame(error)));
      return true;
    }
  }

  private recheck(conn: AppConn): void {
    if (!conn.closed && this.keyRefused(conn)) this.close(conn, CLOSE_UNAUTHORIZED, "unauthorized");
  }

  private async snapshot(conn: AppConn, caller: Caller): Promise<void> {
    const result = await (this.tools as Registry).call(this.hub, caller, "fleetd_status", {});
    if ("output" in result) {
      const s = result.output as Record<string, unknown>;
      await this.sendAnswer(
        conn,
        JSON.stringify({
          t: "snapshot",
          machines: s.machines,
          projects: s.projects,
          attention: s.attention,
          cursor: s.cursor,
          slots: s.slots,
          chats: s.chats,
          // Absent, not null, when the hub never updated itself.
          update: this.hub.peek<Updates>("updates")?.signal(),
        }),
      );
    } else if (result.error.kind === "tool") {
      this.write(conn, JSON.stringify(errorFrame(result.error.error)));
    } else {
      console.error("app snapshot failed:", result.error);
    }
  }

  private message(conn: AppConn, message: string | Buffer): void {
    if (conn.closed) return;
    const inflater = conn.inflater;
    if (typeof message === "string" || !inflater) {
      const text = typeof message === "string" ? message : message.toString("utf8");
      conn.inbox = conn.inbox.then(() => this.frame(conn, text));
      return;
    }
    const inflated = inflater.inflate(message);
    conn.inbox = conn.inbox.then(async () => {
      let text: string;
      try {
        text = await inflated;
      } catch (error) {
        console.warn("an app connection sent a frame that does not inflate:", (error as Error).message);
        return this.close(conn, CLOSE_BAD_DATA, "a compressed frame does not inflate");
      }
      return this.frame(conn, text);
    });
  }

  private frame(conn: AppConn, text: string): void {
    if (conn.closed) return;
    const { message, id } = readMessage(text);
    if (!message) {
      const malformed = new ToolError("invalid", "Unknown or malformed message.", "Send {t:auth|snapshot|events}.");
      this.write(conn, JSON.stringify(errorFrame(malformed, id)));
      return;
    }
    // The upgrade's auth answered the client's first `auth` with this key, and the `snapshot` right after it.
    const early = conn.early;
    conn.early = "none";
    if (early === "auth" && message.t === "auth" && message.key === conn.key) {
      conn.early = "snapshot";
      return;
    }
    if (early === "snapshot" && message.t === "snapshot") return;
    if (message.t === "auth") {
      try {
        const caller = this.hub.auth.verify(message.key);
        this.ready(conn, message.key, caller, message.features ?? []);
      } catch (error) {
        const refusal = error instanceof ToolError ? error : (console.error("key check failed:", error), internalError());
        this.write(conn, JSON.stringify(errorFrame(refusal)));
        this.close(conn, CLOSE_UNAUTHORIZED, "unauthorized");
      }
      return;
    }
    // Every frame goes on the key as it is now: one revoked from the CLI since the last recheck reads nothing more.
    if (this.keyRefused(conn)) return this.close(conn, CLOSE_UNAUTHORIZED, "unauthorized");
    const caller = conn.caller;
    if (!caller) {
      const notAuthed = new ToolError("forbidden", "Not authenticated.", "Send {t:auth,key} first.");
      this.write(conn, JSON.stringify(errorFrame(notAuthed, message.t === "call" ? (message.id as string) : undefined)));
      return;
    }
    switch (message.t) {
      case "snapshot":
        void this.snapshot(conn, caller);
        return;
      case "events":
        this.startStream(conn, message.cursor as number);
        return;
      case "call":
        this.call(conn, caller, message.id as string, message.tool as string, message.input);
        return;
      case "presence":
        try {
          recordPresence(this.hub, caller, message.focused as boolean, message.input as boolean, message.project as never);
        } catch (error) {
          console.warn("app presence not recorded:", error);
        }
        return;
    }
    const handler = this.handlers.get(message.t);
    if (handler) {
      try {
        const out = handler(conn, message);
        if (out instanceof Promise) out.catch((error) => console.error(`app ${message.t} failed:`, error));
      } catch (error) {
        console.error(`app ${message.t} failed:`, error);
      }
      return;
    }
    // An area not ported yet: said once per connection, so a stream of acks or inputs doesn't flood the client.
    if (conn.told.has(message.t)) return;
    conn.told.add(message.t);
    const owner = OWNERS[message.t] ?? "src/hub/app_ws";
    const missing = new ToolError("failed", `not ported to Bun yet: ${owner} (app message ${message.t})`, "Use the Rust hub for this for now.");
    this.write(conn, JSON.stringify(errorFrame(missing)));
  }

  /** One tool call, checked like an MCP request: the key again, the input against the tool's schema, the grants. */
  private call(conn: AppConn, caller: Caller, id: string, tool: string, input: unknown): void {
    if (conn.calls >= MAX_CALLS_IN_FLIGHT) {
      const busy = new ToolError("invalid", `Over ${MAX_CALLS_IN_FLIGHT} calls in flight.`, "Wait for a result before sending more calls.");
      this.write(conn, JSON.stringify(errorFrame(busy, id)));
      return;
    }
    conn.calls++;
    void (async () => {
      let frame: Record<string, unknown>;
      try {
        const result = await (this.tools as Registry).call(this.hub, caller, tool, input);
        if ("output" in result) frame = { t: "result", id, output: result.output };
        else if (result.error.kind === "tool") frame = errorFrame(result.error.error, id);
        else if (result.error.kind === "unknown") {
          frame = errorFrame(new ToolError("not_found", `No tool ${tool}.`, "Use a tool name from the hub's MCP tool list."), id);
        } else {
          const detail = `Invalid ${tool} input: ${result.error.message}`;
          frame = errorFrame(new ToolError("invalid", detail.slice(0, 1000), "Check the input against the tool's input schema."), id);
        }
      } catch (error) {
        console.error(`app call ${tool} failed:`, error);
        frame = errorFrame(internalError(), id);
      }
      const text = JSON.stringify(frame);
      // Status answers share the live feed's per-connection budget: one over it waits for the next second.
      if (tool.startsWith("status_")) {
        for (;;) {
          const wait = conn.reserve(this.hub.clock.now(), text.length);
          if (wait === 0 || conn.closed) break;
          await Bun.sleep(wait);
        }
      }
      conn.calls--;
      await this.sendAnswer(conn, text);
    })();
  }

  // ---- Events.

  /** A new `events` request replaces the running stream: its backlog from the log, then the push. */
  private startStream(conn: AppConn, cursor: number): void {
    this.subscribe();
    const generation = ++this.generation;
    // A cursor past head (a restored database) waits for new events from head, as the log's `wait` does.
    conn.stream = { cursor: Math.min(cursor, events(this.hub).head()), live: false, generation };
    void this.catchUp(conn, generation);
  }

  private subscribe(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = events(this.hub).subscribe((event) => this.push(event));
  }

  /** The Only me projects the connection may not see, read again at most once a second (Rust reads each page). */
  private navis(conn: AppConn, caller: Caller): Others {
    const stream = conn.stream;
    const now = this.hub.clock.now();
    if (stream?.navis && now - stream.navis.at < 1000) return stream.navis.set;
    const set = others(this.hub.db, caller);
    if (stream) stream.navis = { at: now, set };
    return set;
  }

  /** One appended event to every streaming connection riding the push, serialized once. */
  private push(event: HubEvent): void {
    let text: string | undefined;
    // A project's settings changing may change who sees which Only me project.
    const reread = event.type.startsWith("project.") || event.type.startsWith("navi.");
    for (const conn of this.conns) {
      const stream = conn.stream;
      const caller = conn.caller;
      if (!stream?.live || !caller || conn.closed || event.seq <= stream.cursor) continue;
      if (reread && stream.navis) stream.navis = undefined;
      stream.cursor = event.seq;
      if (!visible(this.hub.db, caller, this.navis(conn, caller), event)) continue;
      if (conn.buffered() > MAX_QUEUED_BYTES) {
        // Behind: off the push, and back to its backlog once the socket drains.
        stream.cursor = event.seq - 1;
        stream.live = false;
        void this.catchUp(conn, stream.generation);
        continue;
      }
      text ??= eventFrame(event);
      this.write(conn, text);
    }
  }

  /** Reads the connection's backlog page by page, waiting for room, until it reaches the head; then the push. */
  private async catchUp(conn: AppConn, generation: number): Promise<void> {
    const log = events(this.hub);
    for (;;) {
      const stream = conn.stream;
      if (!stream || stream.generation !== generation || conn.closed) return;
      while (conn.buffered() > MAX_QUEUED_BYTES) {
        await new Promise<void>((r) => conn.drained.push(r));
        if (conn.closed || conn.stream?.generation !== generation) return;
      }
      const caller = conn.caller as Caller;
      const page = log.page(stream.cursor);
      if (page.events.length > 0) {
        const navis = others(this.hub.db, caller);
        for (const event of page.events) {
          if (visible(this.hub.db, caller, navis, event)) this.write(conn, eventFrame(event));
        }
      }
      stream.cursor = page.cursor;
      // No await between the last page and going live: nothing appended in between is missed.
      if (!page.more) {
        stream.live = true;
        return;
      }
      await Promise.resolve();
    }
  }

  private drain(conn: AppConn): void {
    const waiting = conn.drained;
    conn.drained = [];
    for (const resolve of waiting) resolve();
  }

  private closed(conn: AppConn): void {
    if (conn.closed) return;
    conn.closed = true;
    this.conns.delete(conn);
    for (const timer of conn.timers) clearInterval(timer);
    conn.stream = undefined;
    this.drain(conn);
    for (const fn of conn.closeHooks) {
      try {
        fn();
      } catch (error) {
        console.error("app onClose hook failed:", error);
      }
    }
    conn.closeHooks.clear();
    void conn.outbox.then(() => {
      conn.deflater?.close();
      conn.inflater?.close();
    });
  }
}

/** `{ "t": "event", …event }`, as the Rust stream flattens it. */
const eventFrame = (event: HubEvent) => JSON.stringify({ t: "event", ...event });
