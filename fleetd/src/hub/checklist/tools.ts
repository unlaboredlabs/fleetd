// checklist_get: the panel's Checklist tab. checklist_remove: a person takes items off it (Delete, Clear done); the
// lead keeps the rest with its `checklist`, and hears of a removal at its next wake so it leaves those items off.
import type { Registry } from "../api/registry.ts";
import { requireRole } from "../api/grants.ts";
import { renderEvent } from "../leads/events.ts";
import { leadWakes, requireHuman, unknownProject } from "../leads/seams.ts";
import { store } from "../store/hub_store.ts";
import { isoMs, nowMs } from "../store/time.ts";
import { changed, read, remove } from "./index.ts";

export function register(tools: Registry): void {
  tools.add("checklist_get", (hub, caller, input) => {
    const r = input.projectRef;
    requireRole(caller, "read", r.machineId);
    if (!store(hub).projectGet(r)) throw unknownProject(r);
    const list = read(hub.db, r);
    return {
      projectRef: r,
      items: list.items,
      ...(list.updatedMs === undefined ? {} : { updatedAt: isoMs(list.updatedMs) }),
      ...(list.items.length === 0 ? { next: "The project's lead keeps this list; it is empty until the lead sets one." } : {}),
    };
  });

  tools.add("checklist_remove", (hub, caller, input) => {
    const r = input.projectRef;
    requireRole(caller, "operate", r.machineId);
    requireHuman(caller, "checklist_remove");
    if (!store(hub).projectGet(r)) throw unknownProject(r);
    const now = nowMs(hub.clock);
    const { list, removed } = remove(hub.db, r, input.ids ?? [], now);
    if (removed.length > 0) {
      changed(hub, r, list, `human:${caller.name}`, caller.person, now);
      leadWakes(hub).trigger(r, {
        kind: "line",
        line: "quiet",
        text: renderEvent({ kind: "checklist_removed", items: removed.map((i) => [i.id, i.text]) }),
      });
    }
    return { projectRef: r, items: list.items, ...(list.updatedMs === undefined ? {} : { updatedAt: isoMs(list.updatedMs) }) };
  });
}
