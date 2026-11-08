// `hub_info` (crates/fleetd/src/hub/info.rs): the hub's own fleetd build, and everything a restart of the hub (or of
// one machine's node) would cut off now. An update restarts at once anyway: what it cuts off carries on by itself.
import type { Change, HubBusyItem, HubBusyKind, HubEvent, MachineId, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { Requests } from "../approvals/store.ts";
import { shownArgv } from "../approvals/text.ts";
import { jsTake } from "../chat/index.ts";
import { leads } from "../leads/index.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { TaskRecords } from "../tasks/records.ts";
import { changeRecords } from "../train/index.ts";
import { edgeStamp } from "../../update/version.ts";

/** `HubInfoOutput.busy`'s cap. */
export const BUSY_MAX = 50;

/** Edge when the version says so (or nightly), stable for any other release build, none for a local build. */
export function channel(version: string, releaseBuild: boolean): "edge" | "stable" | undefined {
  if (edgeStamp(version) !== undefined) return "edge";
  return releaseBuild ? "stable" : undefined;
}

/** What the hub itself is doing to the Change at the head of its repo's queue, when a restart would cut it off. */
export function hubStep(change: Change): string | undefined {
  if (change.state === "rebasing") return `updating PR #${change.prNumber} in ${change.repo} before it merges`;
  if (change.state === "merging") return `merging PR #${change.prNumber} into ${change.repo}`;
  return undefined;
}

/** One line of at most 280 UTF-16 units, its whitespace collapsed. */
function text(s: string): string {
  const flat = jsTake(s.split(/\s+/u).filter((w) => w !== "").join(" "), 280);
  return flat === "" ? "something is running" : flat;
}

const item = (kind: HubBusyKind, t: string, r: ProjectRef, since?: string): HubBusyItem => ({
  kind,
  machineId: r.machineId,
  projectRef: r,
  ...(since === undefined ? {} : { since }),
  text: text(t),
});

/** Clones a project add started and no `project.added` or `project.add_failed` ended yet (projects `open_clones`). */
export function openClones(hub: Hub): [MachineId | undefined, { repo?: string; path: string }][] {
  const types = ["project.clone_progress", "project.added", "project.add_failed"] as HubEvent["type"][];
  const open = new Map<string, [MachineId | undefined, { repo?: string; path: string }]>();
  let after = 0;
  for (;;) {
    const page = events(hub).page(after, types);
    for (const e of page.events) {
      const id = (e.data as { addId?: unknown } | undefined)?.addId;
      if (typeof id !== "string") continue;
      if (e.type === "project.clone_progress") {
        const d = e.data as { repo?: string; path?: unknown };
        if (typeof d.path === "string") open.set(id, [e.machineId, { ...(d.repo === undefined ? {} : { repo: d.repo }), path: d.path }]);
      } else open.delete(id);
    }
    if (!page.more) break;
    after = page.cursor;
  }
  return [...open.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

/**
 * Everything in flight, every machine: lead turns, running agents, merges at the head of their repo's queue, approved
 * commands still running, and clones. A read that fails fails the call, so a hub that can't tell never reads as idle.
 */
export function busy(hub: Hub): HubBusyItem[] {
  try {
    const title = (r: ProjectRef) => store(hub).projectGet(r)?.title ?? r.projectId;
    const out: HubBusyItem[] = [];
    for (const lead of leads(hub).list()) {
      if (lead.state === "working") out.push(item("lead", `the ${title(lead.projectRef)} lead is working`, lead.projectRef));
    }
    for (const task of TaskRecords.list(hub.db.conn, { state: "running", limit: BUSY_MAX * 4 })) {
      out.push(item("agent", `${task.taskId} in ${title(task.projectRef)}: ${task.title}`, task.projectRef, task.startedAt));
    }
    const records = changeRecords(hub);
    for (const train of records.trains()) {
      const headId = records.trainState(train.repo).head;
      const head = headId === undefined ? undefined : records.get(headId);
      const step = head ? hubStep(head) : undefined;
      if (head && step) out.push(item("train", step, train.projectRef, head.updatedAt));
    }
    for (const request of new Requests(hub.db).list({ states: ["approved"], kind: "approval", limit: BUSY_MAX })) {
      if (!request.gated) continue;
      out.push(
        item("approval", `running \`${shownArgv(request.gated.argv)}\` in ${title(request.projectRef)}, as approved`, request.projectRef, request.answeredAt),
      );
    }
    for (const [machineId, clone] of openClones(hub)) {
      out.push({
        kind: "clone",
        ...(machineId === undefined ? {} : { machineId }),
        text: text(`cloning ${clone.repo ?? clone.path}${machineId === undefined ? "" : ` on ${machineId}`}`),
      });
    }
    return out;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    console.error("hub_info: busy not read:", error);
    throw new ToolError("failed", "The hub failed to answer that request.", "Retry; if it keeps failing, check the hub log.");
  }
}
