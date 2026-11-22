import type { Hub } from "../api/hub.ts";
import { leadWiring } from "../leads/ports.ts";
import { queuePorts } from "../leads/seams.ts";
import { mover } from "./move.ts";

/**
 * Move to the cloud's part of the hub's start (move.ts): a move a restart cut off ends plainly or is followed, and the
 * pause holds the leads' turns and wakes until it lifts. After the usage layer's start, whose holds these wrap.
 */
export function start(hub: Hub): void {
  const m = mover(hub);
  const signal = hub.shutdown.signal;
  const hooks = leadWiring(hub).hooks;
  hooks.moved = () => m.hold();
  const leadHold = hooks.usageHold;
  const leadClear = hooks.whenClear;
  hooks.usageHold = (thread) => m.hold() ?? leadHold?.(thread);
  hooks.whenClear = async (thread) => {
    while (!signal.aborted) {
      await m.whenResumed(signal);
      await leadClear?.(thread);
      if (m.hold() === undefined) return;
    }
  };
  const ports = queuePorts(hub);
  const hold = ports.usageHold;
  const clear = ports.whenClear;
  ports.usageHold = (thread) => m.hold() ?? hold(thread);
  ports.whenClear = async (thread) => {
    while (!signal.aborted) {
      await m.whenResumed(signal);
      await clear(thread);
      if (m.hold() === undefined) return;
    }
  };
  m.recover();
}
