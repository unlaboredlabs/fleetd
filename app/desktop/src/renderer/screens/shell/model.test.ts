import { describe, expect, it } from "vitest";
import { connLine, Seen, sidebarOrders, stepOrder, type SidebarProject } from "./model";

const project = (projectId: string, lastActivityAt: string, orders: Array<string>): SidebarProject => ({
  key: { machineId: "devbox", projectId },
  title: projectId,
  lastActivityAt,
  needsYou: 0,
  stalled: false,
  running: 0,
  orders: orders.map((id) => ({ id, title: `Order ${id}`, needsYou: false })),
});

describe("sidebar orders", () => {
  const projects = [project("storefront", "2026-10-19T10:00:00.000Z", ["W14", "W12"]), project("api", "2026-10-19T09:00:00.000Z", ["W3"])];

  it("follow the project list, each project's orders as listed", () => {
    expect(sidebarOrders(projects)).toEqual(["W14", "W12", "W3"]);
  });

  it("step forward and back, wrapping, from the open order or the ends", () => {
    const ids = sidebarOrders(projects);
    expect(stepOrder(ids, "W12", 1)).toBe("W3");
    expect(stepOrder(ids, "W3", 1)).toBe("W14");
    expect(stepOrder(ids, "W14", -1)).toBe("W3");
    expect(stepOrder(ids, null, 1)).toBe("W14");
    expect(stepOrder(ids, "W99", -1)).toBe("W3");
    expect(stepOrder([], null, 1)).toBeNull();
  });
});

describe("Seen", () => {
  it("counts what was there at connect as read, and new activity after as unread", () => {
    const seen = new Seen();
    const p = project("storefront", "2026-10-19T10:00:00.000Z", []);
    seen.prime([p]);
    expect(seen.unread(p.key, p.lastActivityAt)).toBe(false);
    expect(seen.unread(p.key, "2026-10-19T10:05:00.000Z")).toBe(true);
    seen.mark(p.key, "2026-10-19T10:05:00.000Z");
    expect(seen.unread(p.key, "2026-10-19T10:05:00.000Z")).toBe(false);
    // Priming again after a resync doesn't overwrite what you have (not) seen.
    seen.prime([{ ...p, lastActivityAt: "2026-10-19T11:00:00.000Z" }]);
    expect(seen.unread(p.key, "2026-10-19T11:00:00.000Z")).toBe(true);
  });
});

describe("connLine", () => {
  it("names the hub by its host and says why a retry is happening", () => {
    expect(connLine({ phase: "live", hub: "http://100.64.0.1:4790/", protocol: 1 })).toEqual({ label: "Connected to 100.64.0.1:4790", tone: "success" });
    expect(connLine({ phase: "retrying", hub: "http://hub:4790", reason: "connection reset", retryAt: 0 })).toEqual({
      label: "Reconnecting to hub:4790: connection reset",
      tone: "warning",
    });
    expect(connLine({ phase: "refused", hub: "http://hub:4790", message: "bad key" }).tone).toBe("danger");
    expect(connLine(null).label).toBe("Starting…");
  });
});
