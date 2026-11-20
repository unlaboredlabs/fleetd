// The live subscription on /app: per connection, a pump that turns what
// the hub already knows (thread activity, task and lead state, machine load, the slot board) into `live` frames,
// sending only what changed. A lane goes out as it changes: a thread event of a lane in scope sends that lane within
// SOON_MS, and a task or lead starting or ending reads the whole board again; the ticks are what nothing announces
// (sparklines moving, an ended lane's grace running out): board lanes and slots once a second, focus lanes and streamed
// text 4 times a second, machines every 5 s. All within the connection's 32 KB/s. Latest wins: a tick or a change while
// the socket hasn't taken the last frame waits, so a slow link skips states rather than queueing them.
import type { LiveFrame, ThreadRef, WorkstreamId } from "../../../shared/contracts.ts";
import type { Hub } from "../../api/hub.ts";
import { activity } from "../../executor/activity.ts";
import { events } from "../../store/events.ts";
import type { Caller } from "../../api/registry.ts";
import type { AppConn, AppWs } from "../server.ts";
import { agentLanes, boardLanes, focusLanes, machines, slots } from "./lanes.ts";
import { type LaneNow, Pump } from "./pump.ts";

export const TICK_MS = 250;
/** Board lanes and slots every 4th tick (1 s), machines every 20th (5 s). */
const BOARD_EVERY = 4;
const SLOTS_EVERY = 4;
const MACHINES_EVERY = 20;
/** How soon a change goes out after the frame before it: the changes of a burst share one frame. */
export const SOON_MS = 50;
/** The events that start or end a lane on the board. */
const BOARD_EVENT = /^(task|lead|thread)\./;

const threadKey = (r: ThreadRef) => `${r.machineId}\u0000${r.threadId}`;

export type Scope = { caller: Caller; board: boolean; focus?: WorkstreamId; agent?: string };

/** The connection's running subscription. */
const running = new WeakMap<AppConn, { stop: () => void }>();

/** One tick's lanes, without duplicates: the focus's, the agent's, then the board's on a board tick, else the lanes
 * whose threads moved since the frame before (`moved`, read after the focus's); each part but `moved` goes through
 * `read`, told whether its text is sent. */
function lanesOf(
  hub: Hub,
  scope: Scope,
  boardTick: boolean,
  read: (lanes: LaneNow[], focus: boolean) => LaneNow[],
  moved: () => LaneNow[],
): LaneNow[] {
  const lanes: LaneNow[] = [];
  const seen = new Set<string>();
  const add = (more: LaneNow[]) => {
    for (const l of more) {
      if (seen.has(l.lane.laneId)) continue;
      seen.add(l.lane.laneId);
      lanes.push(l);
    }
  };
  if (scope.focus) add(read(focusLanes(hub, scope.caller, scope.focus), true));
  if (scope.agent) add(read(agentLanes(hub, scope.caller, scope.agent), true));
  if (scope.board && boardTick) add(read(boardLanes(hub, scope.caller), false));
  else add(moved());
  return lanes;
}

/** Starts `scope`'s subscription on `conn`, replacing the one before; none of board, focus and agent stops it. */
export function subscribe(hub: Hub, ws: AppWs, conn: AppConn, scope: Scope, tickMs = TICK_MS): void {
  running.get(conn)?.stop();
  running.delete(conn);
  if (!scope.board && !scope.focus && !scope.agent) return;
  const pump = new Pump();
  let tick = 0;
  /** The lane each thread in scope shows, as last read, and the lanes whose streamed text goes out. */
  const lanesBy = new Map<string, string>();
  const focused = new Set<string>();
  /** Lanes whose thread moved since the frame before, and whether a task or lead started or ended. */
  const moved = new Set<string>();
  let boardMoved = false;
  let sentAt = -Infinity;
  let soon: ReturnType<typeof setTimeout> | undefined;
  const send = (now: number, frame: LiveFrame | undefined) => {
    if (!frame) return;
    const text = JSON.stringify({ t: "live", ...frame });
    conn.spend(now, text.length);
    ws.sendTo(conn, text);
    sentAt = now;
  };
  const read = (lanes: LaneNow[], focus: boolean) => {
    for (const l of lanes) {
      if (l.thread) lanesBy.set(threadKey(l.thread), l.lane.laneId);
      if (focus) focused.add(l.lane.laneId);
    }
    return lanes;
  };
  /** The lanes whose threads moved, their streamed text only on a focused one. */
  const movedLanes = () => {
    const lanes: LaneNow[] = [];
    for (const id of moved) {
      for (const l of agentLanes(hub, scope.caller, id)) {
        if (!focused.has(id)) delete l.text;
        lanes.push(l);
      }
    }
    return lanes;
  };
  const step = () => {
    if (conn.closed || hub.shutdown.signal.aborted) return stop();
    const now = hub.clock.now();
    if (conn.buffered() > 0 || !conn.room(now)) return;
    const first = tick === 0;
    const boardTick = first || tick % BOARD_EVERY === 0 || boardMoved;
    let frame;
    try {
      const m = first || tick % MACHINES_EVERY === 0 ? machines(hub, scope.caller) : undefined;
      const s = first || tick % SLOTS_EVERY === 0 ? slots(hub, scope.caller) : undefined;
      focused.clear();
      if (boardTick) lanesBy.clear();
      frame = pump.frame({
        nowMs: now,
        lanes: lanesOf(hub, scope, boardTick, read, movedLanes),
        boardComplete: !scope.board || boardTick,
        ...(m ? { machines: m } : {}),
        ...(s ? { slots: s } : {}),
      });
    } catch (error) {
      console.error("app live tick failed:", error);
      return;
    }
    tick++;
    moved.clear();
    if (boardTick) boardMoved = false;
    send(now, frame);
  };
  /** Sends what changed since the frame before: the lanes whose threads moved, or the whole board again. */
  const change = () => {
    soon = undefined;
    if (conn.closed || hub.shutdown.signal.aborted) return stop();
    const now = hub.clock.now();
    // Not taken yet: the next tick sends it.
    if (conn.buffered() > 0 || !conn.room(now)) return;
    if (boardMoved) return step();
    let frame;
    try {
      const lanes = movedLanes();
      moved.clear();
      frame = pump.frame({ nowMs: now, lanes, boardComplete: false });
    } catch (error) {
      console.error("app live change failed:", error);
      return;
    }
    send(now, frame);
  };
  const later = () => {
    soon ??= setTimeout(change, Math.max(0, sentAt + SOON_MS - hub.clock.now()));
  };
  const unwatch = activity(hub).watch((r) => {
    const id = lanesBy.get(threadKey(r));
    if (id === undefined) return;
    moved.add(id);
    later();
  });
  const unlisten = scope.board
    ? events(hub).subscribe((event) => {
        if (!BOARD_EVENT.test(event.type)) return;
        boardMoved = true;
        later();
      })
    : () => undefined;
  const timer = setInterval(step, tickMs);
  const off = ws.onClose(conn, () => stop());
  const stop = () => {
    clearInterval(timer);
    clearTimeout(soon);
    unwatch();
    unlisten();
    off();
    if (running.get(conn)?.stop === stop) running.delete(conn);
  };
  running.set(conn, { stop });
  step();
}

/** Serves `live` on /app. */
export function register(hub: Hub, ws: AppWs): void {
  ws.on("live", (conn, message) => {
    const m = message as { board?: unknown; focus?: unknown; agent?: unknown };
    const scope: Scope = {
      caller: conn.caller as Caller,
      board: m.board === true,
      ...(typeof m.focus === "string" && /^W[1-9][0-9]*$/.test(m.focus) ? { focus: m.focus } : {}),
      ...(typeof m.agent === "string" && m.agent !== "" ? { agent: m.agent } : {}),
    };
    subscribe(hub, ws, conn, scope);
  });
}
