// The live subscription on /app: per connection, a pump that turns what
// the hub already knows (thread activity, task and lead state, machine load, the slot board) into `live` frames,
// sending only what changed. Board lanes at most once a second, focus lanes and streamed text at most 4 times a
// second, machines at most every 5 s, slots at most once a second, within the connection's 32 KB/s. Latest wins: a
// tick while the socket hasn't taken the last frame is skipped, so a slow link skips states rather than queueing them.
import type { WorkstreamId } from "../../../shared/contracts.ts";
import type { Hub } from "../../api/hub.ts";
import type { Caller } from "../../api/registry.ts";
import type { AppConn, AppWs } from "../server.ts";
import { agentLanes, boardLanes, focusLanes, machines, slots } from "./lanes.ts";
import { type LaneNow, Pump } from "./pump.ts";

export const TICK_MS = 250;
/** Board lanes and slots every 4th tick (1 s), machines every 20th (5 s). */
const BOARD_EVERY = 4;
const SLOTS_EVERY = 4;
const MACHINES_EVERY = 20;

export type Scope = { caller: Caller; board: boolean; focus?: WorkstreamId; agent?: string };

/** The connection's running subscription. */
const running = new WeakMap<AppConn, { stop: () => void }>();

/** One tick's lanes, without duplicates: the focus's, the agent's, then the board's on a board tick. */
function lanesOf(hub: Hub, scope: Scope, boardTick: boolean): LaneNow[] {
  const lanes: LaneNow[] = [];
  const seen = new Set<string>();
  const add = (more: LaneNow[]) => {
    for (const l of more) {
      if (seen.has(l.lane.laneId)) continue;
      seen.add(l.lane.laneId);
      lanes.push(l);
    }
  };
  if (scope.focus) add(focusLanes(hub, scope.caller, scope.focus));
  if (scope.agent) add(agentLanes(hub, scope.caller, scope.agent));
  if (scope.board && boardTick) add(boardLanes(hub, scope.caller));
  return lanes;
}

/** Starts `scope`'s subscription on `conn`, replacing the one before; none of board, focus and agent stops it. */
export function subscribe(hub: Hub, ws: AppWs, conn: AppConn, scope: Scope, tickMs = TICK_MS): void {
  running.get(conn)?.stop();
  running.delete(conn);
  if (!scope.board && !scope.focus && !scope.agent) return;
  const pump = new Pump();
  let tick = 0;
  const step = () => {
    if (conn.closed || hub.shutdown.signal.aborted) return stop();
    const now = hub.clock.now();
    if (conn.buffered() > 0 || !conn.room(now)) return;
    const first = tick === 0;
    const boardTick = first || tick % BOARD_EVERY === 0;
    let frame;
    try {
      const m = first || tick % MACHINES_EVERY === 0 ? machines(hub, scope.caller) : undefined;
      const s = first || tick % SLOTS_EVERY === 0 ? slots(hub, scope.caller) : undefined;
      frame = pump.frame({
        nowMs: now,
        lanes: lanesOf(hub, scope, boardTick),
        boardComplete: !scope.board || boardTick,
        ...(m ? { machines: m } : {}),
        ...(s ? { slots: s } : {}),
      });
    } catch (error) {
      console.error("app live tick failed:", error);
      return;
    }
    tick++;
    if (!frame) return;
    const text = JSON.stringify({ t: "live", ...frame });
    conn.spend(now, text.length);
    ws.sendTo(conn, text);
  };
  const timer = setInterval(step, tickMs);
  const off = ws.onClose(conn, () => stop());
  const stop = () => {
    clearInterval(timer);
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
