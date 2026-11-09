// The event tools (crates/fleetd/src/hub/api/m1.rs): `events_wait` long-polls the hub's log, `events_list` pages
// back through one project's events. Both leave out what the key may not read (src/hub/app_ws/visible.ts).
import type { EventsListInput, EventsListOutput, EventsWaitInput, EventsWaitOutput } from "../../shared/contracts.ts";
import type { Registry } from "../api/registry.ts";
import { others, someoneElses, visible } from "../app_ws/visible.ts";
import { events } from "../store/events.ts";
import { requireRole } from "./grants.ts";

/** Replaces the registry's NotImplemented stubs for this module's tools (src/hub/api/tool_roles.ts lists them). */
export function register(tools: Registry): void {
  tools.add("events_wait", async (hub, caller, input: EventsWaitInput): Promise<EventsWaitOutput> => {
    if (input.machineId !== undefined) requireRole(caller, "read", input.machineId);
    const log = events(hub);
    let cursor = input.cursor ?? log.head();
    const deadline = hub.clock.now() + (input.timeoutSec ?? 50) * 1000;
    // Returns at once if visible events exist after `cursor`, else waits, through events this key can't see.
    for (;;) {
      const remaining = Math.ceil(Math.max(0, deadline - hub.clock.now()) / 1000);
      const page = await log.wait(
        {
          cursor,
          ...(input.types ? { types: input.types } : {}),
          ...(input.machineId ? { machineId: input.machineId } : {}),
          timeoutSec: remaining,
        },
        hub.shutdown.signal,
      );
      cursor = Math.max(cursor, page.cursor);
      // Another person's Only me project's events are theirs alone, read again as each page comes.
      const navis = others(hub.db, caller);
      const shown = page.events.filter((e) => visible(hub.db, caller, navis, e));
      if (shown.length > 0 || page.events.length === 0 || (remaining === 0 && !page.more) || hub.shutdown.signal.aborted) {
        const next = page.more
          ? `More events are ready: call events_wait with cursor ${cursor} now.`
          : `Call events_wait with cursor ${cursor} to keep waiting.`;
        return { events: shown, cursor, more: page.more, next };
      }
    }
  });

  tools.add("events_list", (hub, caller, input: EventsListInput): EventsListOutput => {
    const r = input.projectRef;
    requireRole(caller, "read", r.machineId);
    const page = events(hub).projectPage(r, input.before, input.types, input.hubWide === true, input.limit ?? 50);
    return { events: page.events.filter((e) => !someoneElses(caller, e)), more: page.more };
  });
}
