import { describe, expect, it } from "vitest";
import { connLine, homeProject, stepProject, toSidebar, type SidebarProject } from "./model";

const row = (projectId: string, marks: Partial<{ needsYou: boolean; working: boolean; running: number }> = {}) => ({
  project: { machineId: "devbox", projectId, title: projectId },
  needsYou: false,
  working: false,
  running: 0,
  ...marks,
});
const sidebar = (ids: Array<string>): ReadonlyArray<SidebarProject> => toSidebar(ids.map((id) => row(id))) ?? [];

describe("sidebar projects", () => {
  it("keeps the layer's order and marks, and says nothing until the projects loaded", () => {
    expect(toSidebar(undefined)).toBeUndefined();
    expect(toSidebar([row("api", { needsYou: true, working: true, running: 3 })])).toEqual([
      { key: { machineId: "devbox", projectId: "api" }, title: "api", needsYou: true, working: true, running: 3 },
    ]);
  });

  it("steps forward and back, wrapping, from the open project or the ends", () => {
    const projects = sidebar(["storefront", "api", "billing"]);
    const key = (projectId: string) => ({ machineId: "devbox", projectId });
    expect(stepProject(projects, key("api"), 1)).toEqual(key("billing"));
    expect(stepProject(projects, key("billing"), 1)).toEqual(key("storefront"));
    expect(stepProject(projects, key("storefront"), -1)).toEqual(key("billing"));
    expect(stepProject(projects, null, 1)).toEqual(key("storefront"));
    expect(stepProject(projects, null, -1)).toEqual(key("billing"));
    expect(stepProject([], null, 1)).toBeNull();
  });

  it("opens to the last project while it exists, else the first, else nothing", () => {
    const projects = sidebar(["storefront", "api"]);
    expect(homeProject(projects, "devbox/api")).toEqual({ machineId: "devbox", projectId: "api" });
    expect(homeProject(projects, "devbox/gone")).toEqual({ machineId: "devbox", projectId: "storefront" });
    expect(homeProject(projects, null)).toEqual({ machineId: "devbox", projectId: "storefront" });
    expect(homeProject([], "devbox/api")).toBeNull();
  });
});

describe("connLine", () => {
  it("names the hub by its host and shows main's reason as it comes", () => {
    expect(connLine({ phase: "live", hub: "http://100.64.0.1:4790/", protocol: 1 })).toEqual({ label: "Connected to 100.64.0.1:4790", tone: "success" });
    expect(connLine({ phase: "retrying", hub: "http://hub:4790", reason: "Nothing is listening at hub:4790", retryAt: 0 })).toEqual({
      label: "Reconnecting: Nothing is listening at hub:4790",
      tone: "warning",
    });
    expect(connLine({ phase: "refused", hub: "http://hub:4790", message: "bad key" }).tone).toBe("danger");
    expect(connLine(null).label).toBe("Starting…");
  });

  it("never says a fixture is connected", () => {
    expect(connLine({ phase: "live", hub: "http://devbox:4790", protocol: 1 }, true)).toEqual({ label: "Sample data, no hub", tone: "quiet" });
  });
});
