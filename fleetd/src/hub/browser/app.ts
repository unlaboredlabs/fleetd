// The /app messages of live screens (crates/fleetd/src/hub/app_ws/mod.rs's browser arms): `browser_watch` (a new
// watch replaces the running one; none stops it), `browser_frame_ack`, `browser_input` and `screen_thumbs`, and the
// `browser_frame`s and `screen_thumb`s they bring. A watch's frames wait in a one-frame slot, replaced by any newer,
// and go when the connection's pace has room: a slow link skips to the newest frame rather than queueing.
import type { BrowserFrame, BrowserInput } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { input, live, startWatch, type Watch } from "./live.ts";
import { Pace, PING } from "./pace.ts";
import type { AppConn, AppWsArea } from "./app_seam.ts";
import { forward } from "./thumbs.ts";

type Outgoing = { text: string; seq: number; bytes: number };

/** One app connection's live screens. */
class Connection {
  watch: Watch | undefined;
  pace: Pace | undefined;
  slot: Outgoing | undefined;
  last: number | undefined;
  deferred: Timer | undefined;
  thumbs: (() => void) | undefined;
  /** The last reason a person's input was refused, logged once until it changes. */
  inputRefused: string | undefined;

  constructor(
    private readonly hub: Hub,
    readonly conn: AppConn,
  ) {}

  stopWatch(): void {
    this.watch?.end();
    this.watch = undefined;
    this.pace = undefined;
    this.slot = undefined;
    this.last = undefined;
    clearTimeout(this.deferred);
    this.deferred = undefined;
  }

  /** Sends the waiting frame when the pace has room, else when it will. */
  pump(): void {
    if (!this.slot) return;
    const now = performance.now();
    const pace = this.pace;
    if (pace) {
      // It waits in the slot, replaced by any newer, until its time or an ack's room.
      const at = pace.notBefore(now);
      if (at !== undefined) return this.defer(at - now);
      const room = pace.room(now);
      if (!room.ok) {
        pace.waited(now);
        if (room.at !== undefined) this.defer(room.at - now);
        return;
      }
    }
    const frame = this.slot;
    this.slot = undefined;
    if (pace) {
      if (pace.ping(now)) this.conn.ws.ping(PING);
      pace.sent(frame.seq, frame.bytes, now);
    }
    appWs(this.hub).sendTo(this.conn, frame.text);
  }

  private defer(ms: number): void {
    if (this.deferred) return;
    this.deferred = setTimeout(() => {
      this.deferred = undefined;
      this.pump();
    }, Math.max(ms, 0));
  }

  end(): void {
    this.stopWatch();
    this.thumbs?.();
    this.thumbs = undefined;
  }
}

/** Each frame's text, made once for every connection watching it: the frame is the node's, the same for all. */
const texts = new WeakMap<BrowserFrame, string>();
function textOf(frame: BrowserFrame): string {
  let text = texts.get(frame);
  if (text === undefined) {
    text = JSON.stringify({ ...frame, t: "browser_frame" });
    texts.set(frame, text);
  }
  return text;
}

/** The /app seam this area is bound to (`bindApp`); its own area, never app_ws's name (D354). */
const bound = (hub: Hub) => hub.area("browser.app_ws", () => ({ app: undefined as AppWsArea | undefined }));

/** Whether some /app seam is bound already (a test's, before the hub's loops start). */
export const appBound = (hub: Hub) => bound(hub).app !== undefined;

/** The /app seam this area sends on: the one `bindApp` gave it. Messages only come once it is bound. */
export function appWs(hub: Hub): AppWsArea {
  const app = bound(hub).app;
  if (!app) throw new Error("browser: no /app seam bound (bindApp)");
  return app;
}

const connections = (hub: Hub) => hub.area("browser.app", () => new Map<AppConn, Connection>());

function connection(hub: Hub, conn: AppConn): Connection {
  const all = connections(hub);
  let c = all.get(conn);
  if (!c) {
    c = new Connection(hub, conn);
    all.set(conn, c);
    appWs(hub).onClose(conn, () => {
      all.get(conn)?.end();
      all.delete(conn);
    });
  }
  return c;
}

const errorFrame = (e: ToolError) => ({ t: "error", ...e.toJSON() });

function refuse(hub: Hub, conn: AppConn, caller: Caller, e: unknown): void {
  if (!(e instanceof ToolError)) throw e;
  appWs(hub).sendTo(conn, errorFrame(caller.kind === "human" ? e.forPerson() : e));
}

export function browserWatch(hub: Hub, conn: AppConn, msg: { session?: string; acks?: boolean; fps?: number }): void {
  const caller = conn.caller;
  if (!caller) return;
  const c = connection(hub, conn);
  c.stopWatch();
  const session = msg.session;
  if (session === undefined) return;
  const onFrame = (frame: BrowserFrame) => {
    if (frame.sessionId !== session) return;
    // The node sends its newest frame again for each `on`: not again to a connection that has it.
    if (c.last === frame.seq) return;
    c.last = frame.seq;
    c.slot = {
      text: textOf(frame),
      seq: frame.seq,
      bytes: Math.floor(frame.jpegB64.length / 4) * 3,
    };
    c.pump();
  };
  try {
    c.watch = startWatch(hub, caller, session, onFrame);
    if (msg.acks) c.pace = new Pace(msg.fps);
  } catch (e) {
    refuse(hub, conn, caller, e);
  }
}

export function browserFrameAck(hub: Hub, conn: AppConn, msg: { seq: number }): void {
  const c = connections(hub).get(conn);
  if (!c?.pace || !c.watch) return;
  c.pace.acked(msg.seq, performance.now());
  c.watch.budget(c.pace.kbps());
  // Room again, maybe, for the frame that waited.
  c.pump();
}

/** A pong on an app connection: the round trip of a pace's ping (app_ws's `onPong`). */
export function pong(hub: Hub, conn: AppConn, payload: Buffer): void {
  if (payload.toString() === PING) connections(hub).get(conn)?.pace?.pong(performance.now());
}

export function browserInput(hub: Hub, conn: AppConn, msg: { session: string; input: BrowserInput }): void {
  const caller = conn.caller;
  if (!caller) return;
  const c = connection(hub, conn);
  try {
    input(hub, caller, msg.session, msg.input);
    c.inputRefused = undefined;
  } catch (e) {
    if (e instanceof ToolError && c.inputRefused !== e.message) {
      // The reason only: never the input, which may be typed text.
      console.warn(`a person's browser input to ${msg.session} refused: ${e.code}: ${e.message}`);
      c.inputRefused = e.message;
    }
    refuse(hub, conn, caller, e);
  }
}

export function screenThumbs(hub: Hub, conn: AppConn, msg: { on?: boolean }): void {
  const caller = conn.caller;
  if (!caller) return;
  const c = connection(hub, conn);
  // The page shows again (a reconnect, a second window) or no more: the running one ends either way.
  c.thumbs?.();
  c.thumbs = msg.on ? forward(hub, live(hub).thumbs, caller, conn) : undefined;
}

/**
 * Binds this area to the /app seam `app`: its client messages come here, and its frames go out there. The hub's loops
 * bind the real one (src/hub/app_ws); tests and benches bind theirs first.
 */
export function bindApp(hub: Hub, app: AppWsArea): void {
  bound(hub).app = app;
  app.on("browser_watch", (conn, m) => browserWatch(hub, conn, m as never));
  app.on("browser_frame_ack", (conn, m) => browserFrameAck(hub, conn, m as never));
  app.on("browser_input", (conn, m) => browserInput(hub, conn, m as never));
  app.on("screen_thumbs", (conn, m) => screenThumbs(hub, conn, m as never));
  app.onPong((conn, data) => pong(hub, conn, data));
}
