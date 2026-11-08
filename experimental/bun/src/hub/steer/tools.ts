// steer_send and steer_withdraw (crates/fleetd/src/hub/steer/tools.rs), with the "References:" lines an order's
// note or steer carries (orders/notes.rs `render_refs`).
import type { IntakeRef, SteerStage } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import * as attachments from "../intake/attachments.ts";
import { leads } from "../leads/index.ts";
import { requireHuman } from "../leads/seams.ts";
import { oneLine } from "../leads/text.ts";
import { TaskRecords } from "../tasks/records.ts";
import { ChangeRecords, parsePrUrl } from "../train/records.ts";
import { send, withdraw } from "./index.ts";

const unknownOrder = (id: string) => new ToolError("not_found", `No order ${id}.`, "Call orders_board to see open orders.");

/** The "References:" lines for a lead: file paths verbatim, orders by id, title and state, PRs by URL. */
export function renderRefs(hub: Hub, caller: Caller, refs: IntakeRef[]): string[] {
  return refs.map((r) => {
    if (r.kind === "file") return `  - \`${r.path}\``;
    if (r.kind === "order") {
      const w = leads(hub).records.workstreamGet(r.workstreamId);
      if (!w || !allows(caller, "read", w.projectRef.machineId)) throw unknownOrder(r.workstreamId);
      return `  - ${w.workstreamId} '${oneLine(w.title, 120)}' (${w.state})`;
    }
    const parsed = parsePrUrl(r.url);
    const change = parsed ? new ChangeRecords(hub.db).latestFor(parsed.repo, parsed.number) : undefined;
    if (change && !allows(caller, "read", change.projectRef.machineId)) {
      throw new ToolError("forbidden", `You may not read ${r.url}.`, "Leave the reference out, or use a key with read on its machine.");
    }
    return change ? `  - ${r.url} (${change.workstreamId}, ${change.state})` : `  - ${r.url}`;
  });
}

const next = (stage: SteerStage) =>
  stage === "queued" ? "Watch for steer.delivered, then steer.acknowledged or steer.unacknowledged, with events_wait." : undefined;

export function register(tools: Registry): void {
  tools.add("steer_send", async (hub, caller, input) => {
    requireHuman(caller, "steer_send");
    const refs = renderRefs(hub, caller, input.refs ?? []);
    const ids = input.attachments ?? [];
    let attached: string[] = [];
    if (ids.length > 0) {
      // The files go to the agent's machine, under the order's folder.
      const target = input.target;
      const workstreamId =
        "workstreamId" in target
          ? target.workstreamId
          : (() => {
              const task = TaskRecords.get(hub.db.conn, target.taskId)?.task;
              if (!task) throw new ToolError("not_found", `No task ${target.taskId}.`);
              return task.workstreamId;
            })();
      const w = leads(hub).records.workstreamGet(workstreamId);
      if (!w) throw unknownOrder(workstreamId);
      attached = await attachments.deliver(hub, caller, ids, w.projectRef, workstreamId, workstreamId);
    }
    const steer = await send(hub, { kind: "human", caller }, {
      target: input.target,
      text: input.text,
      mode: input.mode ?? "queue",
      refs,
      attached,
      clientRequestId: input.clientRequestId,
    });
    const n = next(steer.stage);
    return { ...steer, ...(n === undefined ? {} : { next: n }) };
  });

  tools.add("steer_withdraw", async (hub, caller, input) => {
    requireHuman(caller, "steer_withdraw");
    return { ...(await withdraw(hub, caller, input.steerId)) };
  });
}
