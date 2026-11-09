// The time area's start (and its wiring in hub/serve): the
// event-log projector, the hourly prune, and the node link's `spans` and `hb` frames.
import type { Hub } from "../api/hub.ts";
import { executors } from "../executor/index.ts";
import { link } from "../link/index.ts";
import { time } from "./index.ts";
import type { SpansFrame } from "./ingest.ts";
import { startProjector } from "./project.ts";

export function start(hub: Hub): void {
  const t = time(hub);
  void startProjector(hub);
  t.startPrune();
  const l = link(hub);
  const offs = [
    l.on("hb", (machineId, frame) => {
      const at = (frame as { at?: unknown }).at;
      if (typeof at === "string") t.heartbeat(machineId, at);
    }),
    l.on("spans", (machineId, frame) => {
      const f = frame as unknown as SpansFrame;
      t.nodeSpans({
        machineId,
        frame: { fromRid: f.fromRid, toRid: f.toRid, spans: Array.isArray(f.spans) ? f.spans : [] },
        ack: (ack) => {
          l.send(machineId, { t: "spans_ack", upto: ack.upto, ...(ack.rewind ? { rewind: true } : {}) } as never);
        },
      });
    }),
  ];
  // Subscribes ask nodes for their span outbox from the hub's cursor.
  executors(hub).sinks.spansAfter = (machineId) => t.nodeCursor(machineId);
  hub.shutdown.signal.addEventListener("abort", () => offs.forEach((off) => off()), { once: true });
}
