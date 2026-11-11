import { describe, expect, it } from "vitest";
import type { ProjectRow } from "../../src/data/selectors";
import { homeProject, hubName, nextWanting, stepProject, toSidebar, type MarksIn, type SidebarProject } from "./model";

// Rows as the data layer hands them over: by title.
const row = (projectId: string, marks: Partial<Pick<ProjectRow, "needsYou" | "working" | "running" | "lastSeq">> = {}): ProjectRow =>
  ({
    key: `devbox/${projectId}`,
    project: { machineId: "devbox", projectId, title: projectId, lastActivityAt: "2026-11-08T09:00:00.000Z" },
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
      {
        ...row("api", { needsYou: true, working: true, running: 3 }),
        want: { word: undefined, count: 1, label: "The lead is waiting on you" },
        unread: false,
        warning: undefined,
        line: "",
        at: "2026-11-08T09:00:00.000Z",
        pinned: false,
      },
    ]);
  });

  it("gives each row its newest line, who wrote it, when, and whether you pinned it", () => {
    const marks: MarksIn = {
      latest: {
        "devbox/api": { text: "Merged.", at: "2026-11-08T11:00:00.000Z" },
        "devbox/docs": { text: "ship it", at: "2026-11-08T10:00:00.000Z", person: { id: "p_me", name: "Sam Doe" } },
        "devbox/web": { text: "looks good", at: "2026-11-08T10:30:00.000Z", person: { id: "p_ada", name: "Ada Lovelace" } },
        "devbox/old": { text: "from before people", at: "2026-11-08T08:00:00.000Z", person: { id: "", name: "" } },
      },
      // A chat with no line yet orders by its newest message of any kind, else by its project's activity.
      lastAt: { "devbox/cart": "2026-11-08T12:00:00.000Z" },
      me: "p_me",
      pins: ["devbox/web"],
    };
    const rows = toSidebar(["api", "docs", "web", "old", "cart", "none"].map((id) => row(id)), marks) ?? [];
    expect(rows.map((p) => [p.project.title, p.line, p.at, p.pinned])).toEqual([
      ["api", "Merged.", "2026-11-08T11:00:00.000Z", false],
      ["docs", "You: ship it", "2026-11-08T10:00:00.000Z", false],
      ["web", "Ada: looks good", "2026-11-08T10:30:00.000Z", true],
      ["old", "You: from before people", "2026-11-08T08:00:00.000Z", false],
      ["cart", "", "2026-11-08T12:00:00.000Z", false],
      ["none", "", "2026-11-08T09:00:00.000Z", false],
    ]);
  });

  it("says who wrote a row's newest line by the name they go by now", () => {
    const latest = {
      "devbox/web": { text: "looks good", at: "2026-11-08T10:30:00.000Z", person: { id: "p_ada", name: "Ada Lovelace" } },
      "devbox/docs": { text: "on it", at: "2026-11-08T10:00:00.000Z", person: { id: "p_gone", name: "Lee Park" } },
    };
    const lines = (names?: ReadonlyMap<string, string>) =>
      (toSidebar([row("web"), row("docs")], { latest, me: "p_me", ...(names === undefined ? {} : { names }) }) ?? []).map((p) => p.line);
    // Ada changed her name after she wrote it; Lee has left the hub, so the line keeps the name it was written under.
    expect(lines(new Map([["p_ada", "Countess Lovelace"]]))).toEqual(["Countess: looks good", "Lee: on it"]);
    expect(lines()).toEqual(["Ada: looks good", "Lee: on it"]);
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
        ["devbox/docs", "devbox is offline"],
        ["devbox/cart", undefined],
      ]),
    };
    const rows = [row("api", { needsYou: true }), row("billing", { needsYou: true }), row("cart", { needsYou: true }), row("docs"), row("search")];
    const wants = toSidebar(rows, marks)?.map((p) => [p.project.title, p.want?.word, p.want?.count, p.want?.label]);
    expect(wants).toEqual([
      ["api", "approve", 2, "2 commands to approve"],
      ["billing", "secret", 1, "The lead needs 1 secret from you"],
      ["cart", "reply", 1, "The lead is waiting for your reply"],
      ["docs", "blocked", 1, "Blocked: devbox is offline"],
      ["search", undefined, undefined, undefined],
    ]);
  });

  it("carries a red main as a warning, which wants nothing of you", () => {
    const warnings = new Map([["devbox/docs", "`ios sessions` is red on main, fix in progress"]]);
    const projects = toSidebar([row("api"), row("docs")], { warnings }) ?? [];
    expect(projects.map((p) => [p.project.title, p.want, p.warning])).toEqual([
      ["api", undefined, undefined],
      ["docs", undefined, "`ios sessions` is red on main, fix in progress"],
    ]);
    expect(nextWanting(projects, null)).toBeNull();
  });

  it("marks a chat with a message newer than the one last seen, never the open one or one never seen", () => {
    const rows = [row("api", { lastSeq: 9 }), row("billing", { lastSeq: 4 }), row("cart", { lastSeq: 9 }), row("docs", { lastSeq: 2 })];
    const seen = { "devbox/api": 7, "devbox/billing": 4, "devbox/cart": 3 };
    const unread = toSidebar(rows, { seen, open: { machineId: "devbox", projectId: "cart" } })?.map((p) => [p.project.title, p.unread]);
    expect(unread).toEqual([["api", true], ["billing", false], ["cart", false], ["docs", false]]);
  });

  it("jumps to the next project that wants you, wrapping, and never to the open one alone", () => {
    const ref = (projectId: string) => `devbox/${projectId}`;
    const projects = toSidebar([row("api", { needsYou: true }), row("billing"), row("cart", { needsYou: true }), row("docs")]) ?? [];
    expect(nextWanting(projects, null)?.key).toEqual(ref("api"));
    expect(nextWanting(projects, ref("api"))?.key).toEqual(ref("cart"));
    expect(nextWanting(projects, ref("cart"))?.key).toEqual(ref("api"));
    expect(nextWanting(projects, ref("billing"))?.key).toEqual(ref("cart"));
    const one = toSidebar([row("api", { needsYou: true }), row("billing")]) ?? [];
    expect(nextWanting(one, ref("api"))).toBeNull();
    expect(nextWanting(sidebar(["api"]), null)).toBeNull();
  });

  it("steps forward and back, wrapping, from the open project or the ends", () => {
    const projects = sidebar(["api", "billing", "storefront"]);
    const key = (projectId: string) => `devbox/${projectId}`;
    expect(stepProject(projects, key("api"), 1)?.key).toEqual(key("billing"));
    expect(stepProject(projects, key("storefront"), 1)?.key).toEqual(key("api"));
    expect(stepProject(projects, key("api"), -1)?.key).toEqual(key("storefront"));
    expect(stepProject(projects, null, 1)?.key).toEqual(key("api"));
    expect(stepProject(projects, null, -1)?.key).toEqual(key("storefront"));
    expect(stepProject([], null, 1)).toBeNull();
  });

  it("opens to the last project while it exists, else the first, else nothing", () => {
    const projects = sidebar(["api", "storefront"]);
    expect(homeProject(projects, "devbox/storefront")?.key).toEqual("devbox/storefront");
    expect(homeProject(projects, "devbox/gone")?.key).toEqual("devbox/api");
    expect(homeProject(projects, null)?.key).toEqual("devbox/api");
    expect(homeProject([], "devbox/api")).toBeNull();
  });
});

describe("hubName", () => {
  it("is the first label of the host, without scheme, port or path", () => {
    expect(hubName("https://devbox.example.ts.net:4790/")).toBe("devbox");
    expect(hubName("http://hub:4790")).toBe("hub");
    expect(hubName("ws://Hub.Local/api")).toBe("Hub");
    expect(hubName("devbox.example.ts.net")).toBe("devbox");
  });

  it("keeps an address whole, without its port", () => {
    expect(hubName("http://100.64.0.1:4790/")).toBe("100.64.0.1");
    expect(hubName("http://[fd7a:115c::1]:4790")).toBe("[fd7a:115c::1]");
  });
});
