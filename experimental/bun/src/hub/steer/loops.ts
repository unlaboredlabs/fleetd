// The steer area's start (crates/fleetd/src/hub/steer/mod.rs `wire`, `run_sweep`): node receipts and the offline
// queue's expiries reach the steers, the lead's `task message` goes through them, and once a minute the sweep closes
// steers whose receipt can't come.
import type { Hub } from "../api/hub.ts";
import { executors } from "../executor/index.ts";
import { leadCalls } from "../lead_calls/index.ts";
import { ToolError } from "../../shared/errors.ts";
import { TaskRecords } from "../tasks/records.ts";
import { writeQueue } from "../queue/index.ts";
import { expired, onReceipt, send, sweep } from "./index.ts";

export function start(hub: Hub): void {
  executors(hub).sinks.steer = (machineId, receipt) => onReceipt(hub, machineId, receipt);
  // Steers the offline queue gave up on are closed.
  writeQueue(hub).onSteerExpired((id, reason) => expired(hub, id, reason));
  // `fleetd task message T88 "<text>" [--now]`: the lead steers its own task, with the same modes and receipts.
  leadCalls(hub).register("task_message", async (caller, call) => {
    const { taskId, message, now } = call as { taskId?: unknown; message?: unknown; now?: unknown };
    if (typeof taskId !== "string" || typeof message !== "string" || !message) throw new ToolError("invalid", "Not a task message.");
    const crid = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
    const steer = await send(hub, { kind: "lead", project: caller.projectRef }, {
      target: { taskId },
      text: message,
      mode: now === true ? "now" : "queue",
      refs: [],
      attached: [],
      clientRequestId: crid,
    });
    const task = TaskRecords.get(hub.db.conn, taskId)?.task;
    if (!task) throw new ToolError("not_found", `No task ${taskId}.`, "Call orders_board to see open orders and their agents.");
    return { task, next: `${steer.id} ${steer.detail ?? "sent"}: its next reply acknowledges it.`, steerId: steer.id };
  });
  const timer = setInterval(() => {
    const closed = sweep(hub);
    if (closed > 0) console.info(`${closed} steers closed without a final receipt`);
  }, 60_000);
  hub.shutdown.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
