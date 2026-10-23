import { describe, expect, it } from "vitest";
import type { ProjectRow } from "../../src/data/selectors";
import { connLine, homeProject, nextWanting, stepProject, toSidebar, type MarksIn, type SidebarProject } from "./model";

// Rows as the data layer hands them over: by title.
const row = (projectId: string, marks: Partial<Pick<ProjectRow, "needsYou" | "working" | "running" | "lastSeq">> = {}): ProjectRow =>
  ({
    key: `devbox/${projectId}`,
    project: { machineId: "devbox", projectId, title: projectId },
    needsYou: false,
    working: false,
    running: 0,
    state: "idle",
    ...marks,
  }) as ProjectRow;
const sidebar = (ids: Array<string>): ReadonlyArray<SidebarProject> => toSidebar(ids.map((id) => row(id))) ?? [];

describe("sidebar projects", () => {
  it("keeps each project's marks, and says nothing until the projects loaded", () => {
    expect(toSidebar(undefined)).toBeUndefined();
    expect(toSidebar([row("api", { needsYou: true, working: true, running: 3 })])).toEqual([
      { ...row("api", { needsYou: true, working: true, running: 3 }), want: { word: undefined, count: 1, label: "The lead is waiting on you" }, unread: false },
    ]);
  });

  it("says why each project wants you: a secret or approval first, then a reply, then blocked", () => {
    const ref = (projectId: string) => ({ machineId: "devbox", projectId });
    const marks: MarksIn = {
      requests: [
        { projectRef: ref("api"), kind: "approval", state: "open" },
        { projectRef: ref("api"), kind: "approval", state: "open" },
        { projectRef: ref("api"), kind: "secret", state: "stored" },
        { projectRef: ref("billing"), kind: "secret", state: "open" },
        { projectRef: ref("billing"), kind: "approval", state: "open" },
      ],
      blocked: new Map([
        ["devbox/docs", "main CI is red"],
        ["devbox/cart", undefined],
      ]),
    };
    const rows = [row("api", { needsYou: true }), row("billing", { needsYou: true }), row("cart", { needsYou: true }), row("docs"), row("search")];
    const wants = toSidebar(rows, marks)?.map((p) => [p.project.title, p.want?.word, p.want?.count, p.want?.label]);
    expect(wants).toEqual([
      ["api", "approve", 2, "2 commands to approve"],
      ["billing", "secret", 1, "The lead needs 1 secret from you"],
      ["cart", "reply", 1, "The lead is waiting for your reply"],
      ["docs", "blocked", 1, "Blocked: main CI is red"],
      ["search", undefined, undefined, undefined],
    ]);
  });

  it("marks a chat with a message newer than the one last seen, never the open one or one never seen", () => {
    const rows = [row("api", { lastSeq: 9 }), row("billing", { lastSeq: 4 }), row("cart", { lastSeq: 9 }), row("docs", { lastSeq: 2 })];
    const seen = { "devbox/api": 7, "devbox/billing": 4, "devbox/cart": 3 };
    const unread = toSidebar(rows, { seen, open: { machineId: "devbox", projectId: "cart" } })?.map((p) => [p.project.title, p.unread]);
    expect(unread).toEqual([["api", true], ["billing", false], ["cart", false], ["docs", false]]);
  });

  it("jumps to the next project that wants you, wrapping, and never to the open one alone", () => {
    const ref = (projectId: string) => ({ machineId: "devbox", projectId });
    const projects = toSidebar([row("api", { needsYou: true }), row("billing"), row("cart", { needsYou: true }), row("docs")]) ?? [];
    expect(nextWanting(projects, null)).toEqual(ref("api"));
    expect(nextWanting(projects, ref("api"))).toEqual(ref("cart"));
    expect(nextWanting(projects, ref("cart"))).toEqual(ref("api"));
    expect(nextWanting(projects, ref("billing"))).toEqual(ref("cart"));
    const one = toSidebar([row("api", { needsYou: true }), row("billing")]) ?? [];
    expect(nextWanting(one, ref("api"))).toBeNull();
    expect(nextWanting(sidebar(["api"]), null)).toBeNull();
  });

  it("steps forward and back, wrapping, from the open project or the ends", () => {
    const projects = sidebar(["api", "billing", "storefront"]);
    const key = (projectId: string) => ({ machineId: "devbox", projectId });
    expect(stepProject(projects, key("api"), 1)).toEqual(key("billing"));
    expect(stepProject(projects, key("storefront"), 1)).toEqual(key("api"));
    expect(stepProject(projects, key("api"), -1)).toEqual(key("storefront"));
    expect(stepProject(projects, null, 1)).toEqual(key("api"));
    expect(stepProject(projects, null, -1)).toEqual(key("storefront"));
    expect(stepProject([], null, 1)).toBeNull();
  });

  it("opens to the last project while it exists, else the first, else nothing", () => {
    const projects = sidebar(["api", "storefront"]);
    expect(homeProject(projects, "devbox/api")).toEqual({ machineId: "devbox", projectId: "api" });
    expect(homeProject(projects, "devbox/gone")).toEqual({ machineId: "devbox", projectId: "api" });
    expect(homeProject(projects, null)).toEqual({ machineId: "devbox", projectId: "api" });
    expect(homeProject([], "devbox/api")).toBeNull();
  });
});

describe("connLine", () => {
  it("names the hub by its host, and offline marks the projects with when they were last current", () => {
    expect(connLine({ phase: "live", hub: "http://100.64.0.1:4790/", protocol: 1 })).toEqual({ label: "Connected to 100.64.0.1:4790", tone: "success" });
    const down = { phase: "retrying", hub: "http://hub:4790", reason: "Nothing is listening at hub:4790", retryAt: 0 } as const;
    expect(connLine(down, false, "as of 09:02")).toEqual({ label: "Offline, as of 09:02", tone: "warning" });
    expect(connLine(down).label).toBe("Offline");
    expect(connLine({ phase: "refused", hub: "http://hub:4790", message: "bad key" }).tone).toBe("danger");
  });

  it("never says a fixture is connected", () => {
    expect(connLine({ phase: "live", hub: "http://devbox:4790", protocol: 1 }, true)).toEqual({ label: "Sample data, no hub", tone: "quiet" });
  });
});
