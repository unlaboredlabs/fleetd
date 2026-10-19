import { describe, expect, it } from "vitest";
import { connLine, Seen, sidebarOrders, stepOrder, toShellData, type ShellInputs, type SidebarProject } from "./model";

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

describe("toShellData", () => {
  const storefront = { machineId: "devbox", projectId: "storefront" };
  const api = { machineId: "buildbox", projectId: "api" };
  const now = Date.parse("2026-10-19T10:30:00.000Z");
  const order = (id: string, projectRef: typeof storefront, phase: string, updatedAt: string, lanes: Array<string>, asks = 0) => ({
    card: { workstreamId: id, title: `Order ${id}`, projectRef, updatedAt },
    phase: { phase },
    asks: Array.from({ length: asks }, () => ({})),
    lanes: lanes.map((status) => ({ status })),
  });
  const inputs: ShellInputs = {
    projects: [
      { ...storefront, title: "storefront", lastActivityAt: "2026-10-19T10:00:00.000Z" },
      { ...api, title: "api", lastActivityAt: "2026-10-19T09:00:00.000Z" },
    ],
    board: [
      order("W14", storefront, "waiting_on_you", "2026-10-19T10:20:00.000Z", ["working", "waiting"], 1),
      order("W12", storefront, "working", "2026-10-19T10:10:00.000Z", ["starting", "done"]),
      order("W9", storefront, "done", "2026-10-19T10:25:00.000Z", []),
      order("W3", api, "done", "2026-10-19T09:00:00.000Z", []),
    ],
    inbox: [{ ask: { projectRef: storefront } }, { ask: {} }],
    machines: [{ machine: { status: "online" } }, { machine: { status: "offline" } }],
    leadStatus: (key) => (key.projectId === "api" ? "stalled" : "working"),
  };

  it("lists each project's open orders in board order, and recently finished ones for a while", () => {
    const data = toShellData(inputs, now);
    expect(data.projects?.map((p) => p.orders.map((o) => o.id))).toEqual([["W14", "W12", "W9"], []]);
  });

  it("counts what needs you, running agents, stalled leads and machines down", () => {
    const [front, back] = toShellData(inputs, now).projects ?? [];
    expect(front).toMatchObject({ needsYou: 1, running: 2, stalled: false });
    expect(front?.orders[0]?.needsYou).toBe(true);
    expect(back).toMatchObject({ needsYou: 0, running: 0, stalled: true });
    expect(toShellData(inputs, now)).toMatchObject({ machinesDown: 1 });
  });

  it("says nothing about projects, orders or asks it hasn't loaded yet", () => {
    expect(toShellData({ ...inputs, projects: undefined }, now).projects).toBeUndefined();
    const listed = toShellData({ ...inputs, board: undefined, inbox: undefined }, now).projects ?? [];
    expect(listed.map((p) => [p.orders.length, p.needsYou])).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });
});
