// `sidebar_order_get` and `sidebar_order_set`: a person's sidebar order,
// the same on each of their desktops. A set announces `sidebar.order`, which only that person's devices see.
import type { SidebarOrderSetInput } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Registry } from "../api/registry.ts";
import { isoMs } from "../auth/index.ts";
import { events, type NewEvent } from "../store/events.ts";
import { me, putRefs, refsOf } from "./store.ts";

export function register(tools: Registry): void {
  tools.add("sidebar_order_get", (hub, caller) => {
    const person = me(hub, caller);
    // Nobody's: the sidebar keeps its own order.
    return { order: person === undefined ? [] : (refsOf(hub.db.conn, "sidebar_orders", person) ?? []) };
  });

  tools.add("sidebar_order_set", (hub, caller, input: SidebarOrderSetInput) => {
    const person = me(hub, caller);
    if (person === undefined) {
      throw new ToolError(
        "forbidden",
        "Only a person keeps a sidebar order, from one of their own devices.",
        "Pair the app as yourself, then drag a project in its sidebar.",
      );
    }
    putRefs(hub.db.conn, "sidebar_orders", person, input.order);
    try {
      events(hub).append({
        at: isoMs(hub.clock.now()),
        type: "sidebar.order",
        summary: "Sidebar order changed",
        data: { personId: person },
      } as NewEvent);
    } catch (error) {
      // The order is saved; a missed event only means the person's other desktops catch up at their next read.
      console.warn(`sidebar.order event not recorded for ${person}:`, error);
    }
    return { order: input.order };
  });
}
