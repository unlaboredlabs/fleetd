// The /app messages of live screens (crates/fleetd/src/hub/app_ws/mod.rs's browser arms): `browser_watch` (a new
// watch replaces the running one; none stops it), `browser_frame_ack`, `browser_input`, `browser_rtc` and
// `screen_thumbs`, and the `browser_frame`s and `screen_thumb`s they bring. A `browser_rtc` offer goes on to the
// screen's node and its answer back (src/node/rtc): the frames and input then go peer to peer, and a watch whose
// `rtc` names an open peer gets no frames here. The same watch again with `rtc` changed only moves it on or off its
// peer: off it, the stream starts again at a whole picture. Each peer's key is checked again every RTC_RECHECK_MS and
// on every revocation, as the socket checks its own on every frame: one that can no longer watch the screen, or no
// longer drive it when its peer carries input, has its peer closed, and the app is back on the socket, where its
// input is refused as any other's. A watch that acks its frames gets them through a
// FrameSender (./flow.ts): as many on their way as the acks' round trip needs, none taken while a queue stands, and its
// budget from the same acks. One that doesn't ack gets each frame as it comes.
import type { BrowserFrame, BrowserInput, ScreenPerf } from "../../shared/contracts.ts";
import { CAP_BROWSER_RTC } from "../../shared/node_link.ts";
import type { BrowserRtcReport } from "../../shared/screens_wire.ts";
import { allows } from "../auth/index.ts";
import { isHuman } from "../api/grants.ts";
import { link } from "../link/index.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { input, live, runsOn, startWatch, type Watch } from "./live.ts";
import { get } from "./store.ts";
import { FrameSender } from "./flow.ts";
import type { AppConn, AppWsArea } from "./app_seam.ts";
import { forward } from "./thumbs.ts";

/** One app connection's live screens. */
class Connection {
  watch: Watch | undefined;
  /** What the running watch asked: the same again with another `rtc` only moves it on or off its peer. */
  asked: { session: string; acks: boolean; fps: number | undefined; video: boolean } | undefined;
  /** The app's peers, by its own id: the hub's id for each, the node's, and its session. */
  readonly peers = new Map<string, { id: string; machine: string; session: string; owner: string; input: boolean }>();
  /** The acking watch's frames, paced to its acks. */
  sender: FrameSender<BrowserFrame> | undefined;
  /** The screen's newest measures not sent yet: they go, with this connection's link's, on the next frame that does. */
  perf: ScreenPerf | undefined;
  /** The last frame sent, by its link and seq. */
  last: { link: number | undefined; seq: number } | undefined;
  thumbs: (() => void) | undefined;
  /** The last reason a person's input was refused, logged once until it changes. */
  inputRefused: string | undefined;
  /** The app's peer the watch's frames come on (`browser_watch`'s `rtc`): none go here meanwhile. */
  rtc: string | undefined;

  constructor(
    private readonly hub: Hub,
    readonly conn: AppConn,
  ) {}

  stopWatch(): void {
    this.watch?.end();
    this.watch = undefined;
    this.asked = undefined;
    this.sender?.end();
    this.sender = undefined;
    this.last = undefined;
  }

  end(): void {
    this.stopWatch();
    this.thumbs?.();
    this.thumbs = undefined;
    for (const peer of [...this.peers.keys()]) closePeer(this.hub, this, peer);
  }
}

/** The app peers' by the hub's id for each: which connection, and its own id. */
const peerIds = (hub: Hub) =>
  hub.area("browser.rtc", () => ({
    n: 0,
    byId: new Map<string, { c: Connection; peer: string }>(),
    timer: undefined as ReturnType<typeof setInterval> | undefined,
    revokes: false,
  }));

/** An app connection holds this many peers at most: its windows' screens, and one being replaced. */
export const MAX_APP_PEERS = 4;
/** Each peer's key is checked again this often: a role or grant it lost stops its frames and input within this. */
export const RTC_RECHECK_MS = 2_000;

/** Whether `caller` may watch a screen of `owner`'s machine, and drive it. */
const access = (caller: Caller | undefined, owner: string) => ({
  read: caller !== undefined && allows(caller, "read", owner),
  input: caller !== undefined && isHuman(caller) && allows(caller, "operate", owner),
});

/** The connection's caller as its key is now: undefined once the key is refused (the socket closes it too). */
function callerNow(hub: Hub, conn: AppConn): Caller | undefined {
  if (conn.key === undefined) return conn.caller;
  try {
    return hub.auth.verify(conn.key) as Caller;
  } catch {
    return undefined;
  }
}

/** Closes each peer whose key lost what it was let in with. */
export function recheckPeers(hub: Hub): void {
  for (const { c, peer } of [...peerIds(hub).byId.values()]) {
    const p = c.peers.get(peer);
    if (!p) continue;
    const now = access(callerNow(hub, c.conn), p.owner);
    if (now.read && (now.input || !p.input)) continue;
    closePeer(hub, c, peer);
    appWs(hub).sendTo(c.conn, { t: "browser_rtc", session: p.session, peer, error: "Your access to this screen changed." });
  }
}

/** Rechecks every RTC_RECHECK_MS while any peer is open, and on every revocation. */
function watchPeers(hub: Hub): void {
  const ids = peerIds(hub);
  if (ids.timer !== undefined) return;
  ids.timer = setInterval(() => {
    recheckPeers(hub);
    if (ids.byId.size === 0) {
      clearInterval(ids.timer);
      ids.timer = undefined;
    }
  }, RTC_RECHECK_MS);
  if (!ids.revokes) {
    ids.revokes = true;
    hub.auth.onRevoke(() => recheckPeers(hub));
    hub.shutdown.signal.addEventListener("abort", () => clearInterval(ids.timer), { once: true });
  }
}

/** Closes the app's peer `peer`: the node is told, and the watch it carried takes its frames here again. */
function closePeer(hub: Hub, c: Connection, peer: string): void {
  const p = c.peers.get(peer);
  if (!p) return;
  c.peers.delete(peer);
  peerIds(hub).byId.delete(p.id);
  link(hub).send(p.machine, { t: "browser_rtc", sessionId: p.session, peer: p.id });
  if (c.rtc === peer) offPeer(c);
}

/** The watch's frames come through the hub again, from a whole picture. */
function offPeer(c: Connection): void {
  c.rtc = undefined;
  if (!c.watch) return;
  c.watch.peer(false);
  if (c.sender) c.sender.needKey = true;
  c.watch.key();
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

export function browserWatch(
  hub: Hub,
  conn: AppConn,
  msg: { session?: string; acks?: boolean; fps?: number; video?: boolean; rtc?: string },
): void {
  const caller = conn.caller;
  if (!caller) return;
  const c = connection(hub, conn);
  const session = msg.session;
  const asked = session === undefined ? undefined : { session, acks: msg.acks === true, fps: msg.fps, video: msg.video === true };
  // A peer of this connection's for this session, or none.
  const rtc = msg.rtc !== undefined && c.peers.get(msg.rtc)?.session === session ? msg.rtc : undefined;
  const a = c.asked;
  if (c.watch && a && asked && a.session === asked.session && a.acks === asked.acks && a.fps === asked.fps && a.video === asked.video) {
    if (rtc === c.rtc) return;
    if (rtc === undefined) return offPeer(c);
    c.rtc = rtc;
    c.watch.peer(true);
    return;
  }
  c.stopWatch();
  c.rtc = undefined;
  if (session === undefined) return;
  const onFrame = (frame: BrowserFrame) => {
    if (frame.sessionId !== session) return;
    // The node sends its newest frame again for each `on`: not again to a connection that has it.
    if (c.last?.seq === frame.seq && c.last.link === frame.link) return;
    c.last = { link: frame.link, seq: frame.seq };
    // On the app's peer: it has this one already.
    if (c.rtc !== undefined) return;
    if (!c.sender) return void appWs(hub).sendTo(conn, textOf(frame));
    const h264 = frame.h264B64 !== undefined;
    if (frame.perf !== undefined) c.perf = frame.perf;
    c.sender.offer({ seq: frame.seq, bytes: Math.floor((frame.jpegB64 ?? frame.h264B64 ?? "").length / 4) * 3, h264, key: frame.key === true, data: frame });
  };
  try {
    // While its machine isn't linked, the app shows it waits for it, over the last picture, until the next frame.
    const waiting = (machine: string) => appWs(hub).sendTo(conn, { t: "browser_waiting", sessionId: session, machineId: machine });
    c.watch = startWatch(hub, caller, session, onFrame, msg.video === true, waiting);
    c.asked = asked;
    if (msg.acks) {
      const w = c.watch;
      const sender: FrameSender<BrowserFrame> = new FrameSender<BrowserFrame>(
        {
          // The screen's newest measures go on the next frame that does, with this connection's own link's (the
          // performance panel's): that frame's text is its own.
          send: (f) => {
            const perf = c.perf;
            c.perf = undefined;
            // A frame whose own measures an earlier one carried goes without them: one measure a frame number.
            const text =
              perf !== undefined
                ? JSON.stringify({ ...f.data, perf: { ...perf, link: sender.stats() }, t: "browser_frame" })
                : f.data.perf === undefined
                  ? textOf(f.data)
                  : JSON.stringify({ ...f.data, perf: undefined, t: "browser_frame" });
            void appWs(hub).sendTo(conn, text);
          },
          key: () => w.key(),
          budget: (kbps) => w.budget(kbps),
        },
        msg.fps,
      );
      c.sender = sender;
    }
    if (rtc !== undefined) {
      c.rtc = rtc;
      c.watch.peer(true);
    }
  } catch (e) {
    refuse(hub, conn, caller, e);
  }
}

export function browserFrameAck(hub: Hub, conn: AppConn, msg: { seq: number }): void {
  connections(hub).get(conn)?.sender?.ack(msg.seq);
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

/**
 * The app's `browser_rtc`: an offer for a session the key may watch goes on to its node, with whether input on it
 * may drive the screen (a person's key with operate on the machine, as `browser_input` asks); without one, the peer
 * closes. Refused with a `browser_rtc` that says why, and the app stays on the socket.
 */
export function browserRtc(hub: Hub, conn: AppConn, msg: { session: string; peer: string; offer?: string }): void {
  const caller = conn.caller;
  if (!caller) return;
  const c = connection(hub, conn);
  const refuse = (error: string): void => void appWs(hub).sendTo(conn, { t: "browser_rtc", session: msg.session, peer: msg.peer, error });
  if (msg.offer === undefined || c.peers.has(msg.peer)) {
    closePeer(hub, c, msg.peer);
    if (msg.offer === undefined) return;
  }
  const s = get(hub, msg.session);
  if (!s || !allows(caller, "read", s.projectRef.machineId)) return refuse(`No screen ${msg.session}.`);
  if (s.state !== "live") return refuse(`Screen ${msg.session} is ${s.state}.`);
  const machine = runsOn(hub, s);
  if (!link(hub).can(machine, CAP_BROWSER_RTC)) return refuse(`${machine}'s node isn't connected, or is too old for screens peer to peer.`);
  if (c.peers.size >= MAX_APP_PEERS) return refuse(`This connection has ${MAX_APP_PEERS} screen peers open already.`);
  const ids = peerIds(hub);
  const id = `p${++ids.n}`;
  const owner = s.projectRef.machineId;
  const { input } = access(caller, owner);
  c.peers.set(msg.peer, { id, machine, session: msg.session, owner, input });
  ids.byId.set(id, { c, peer: msg.peer });
  watchPeers(hub);
  if (!link(hub).send(machine, { t: "browser_rtc", sessionId: msg.session, peer: id, offer: msg.offer, input })) {
    closePeer(hub, c, msg.peer);
    refuse(`${machine}'s node isn't connected.`);
  }
}

/** A node's `browser_rtc`: its answer to an app's offer, or its peer's end, for that app; a person's input on it. */
export function rtcReport(hub: Hub, machine: string, r: BrowserRtcReport): void {
  const ids = peerIds(hub);
  const p = ids.byId.get(r.peer);
  const held = p?.c.peers.get(p.peer);
  if (!p || !held || held.machine !== machine) return;
  if (r.input) live(hub).noteInput(held.session, hub.clock.now());
  if (r.answer !== undefined) appWs(hub).sendTo(p.c.conn, { t: "browser_rtc", session: held.session, peer: p.peer, answer: r.answer });
  if (r.closed || r.error !== undefined) {
    p.c.peers.delete(p.peer);
    ids.byId.delete(r.peer);
    if (p.c.rtc === p.peer) offPeer(p.c);
    appWs(hub).sendTo(p.c.conn, { t: "browser_rtc", session: held.session, peer: p.peer, error: r.error ?? "The peer closed." });
  }
}

/** A machine linked again: its node's peers ended with its last link. */
export function rtcRelinked(hub: Hub, machine: string): void {
  for (const [id, p] of [...peerIds(hub).byId]) {
    if (p.c.peers.get(p.peer)?.machine === machine) rtcReport(hub, machine, { sessionId: "", peer: id, closed: true, error: "The screen's machine linked again." });
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
  app.on("browser_rtc", (conn, m) => browserRtc(hub, conn, m as never));
  app.on("screen_thumbs", (conn, m) => screenThumbs(hub, conn, m as never));
}
