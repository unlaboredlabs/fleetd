import { describe, expect, it } from "vitest";
import { PANEL_TABS } from "../panel/tabs";
import { HOME, hasItem, listView, panelRoute, parseHash, toHash, type Screen } from "./routes";

const storefront = { machineId: "devbox", projectId: "storefront" };

describe("routes", () => {
  it("round-trips every screen", () => {
    const screens: Array<Screen> = [
      HOME,
      { id: "project", project: storefront, message: null },
      { id: "project", project: storefront, message: "m-42" },
      panelRoute(storefront, { tab: "prs", pr: null }),
      panelRoute(storefront, { tab: "prs", pr: { repo: null, number: 11 } }),
      panelRoute(storefront, { tab: "prs", pr: { repo: "acme/storefront", number: 11 } }),
      panelRoute(storefront, { tab: "agents", agent: null }),
      panelRoute(storefront, { tab: "agents", agent: "lead:devbox/storefront" }),
      panelRoute(storefront, { tab: "sessions", session: null }),
      panelRoute(storefront, { tab: "sessions", session: "bs-checkout" }),
      { id: "session", project: storefront, session: "bs-checkout" },
      panelRoute(storefront, { tab: "checklist" }),
      { id: "project", project: storefront, message: "m-42", panel: { tab: "agents", agent: "T1" } },
      { id: "status" },
      { id: "factory", project: null },
      { id: "factory", project: storefront },
      { id: "factory", project: { machineId: "dev box", projectId: "a/b" } },
      { id: "machines" },
      { id: "time", orderId: null },
      { id: "time", orderId: "W14" },
      { id: "projects.add" },
      { id: "settings", tab: "prompts" },
      { id: "admin", section: "people" },
      { id: "admin", section: "machines" },
      { id: "admin", section: "machines", machine: "laptop" },
      { id: "admin", section: "hub" },
      { id: "onboarding", hub: "http://100.64.0.1:4790", code: "ABCD-2345" },
      { id: "onboarding", hub: null, code: null },
    ];
    for (const screen of screens) expect(parseHash(toHash(screen))).toEqual(screen);
  });

  it("writes the hashes the screens and the QA registry use", () => {
    expect(toHash(HOME)).toBe("#/");
    expect(toHash({ id: "project", project: storefront, message: "m-42" })).toBe("#/project/devbox/storefront?message=m-42");
    expect(toHash({ id: "project", project: { machineId: "dev box", projectId: "a/b" }, message: null })).toBe("#/project/dev%20box/a%2Fb");
    expect(toHash({ id: "settings", tab: "general" })).toBe("#/settings/general");
    // Status's PRs link is the chat's route plus /prs.
    expect(toHash(panelRoute(storefront, { tab: "prs", pr: null }))).toBe("#/project/devbox/storefront/prs");
    expect(toHash(panelRoute(storefront, { tab: "prs", pr: { repo: "acme/storefront", number: 11 } }))).toBe("#/project/devbox/storefront/prs/acme/storefront/11");
    expect(toHash(panelRoute(storefront, { tab: "prs", pr: { repo: null, number: 11 } }))).toBe("#/project/devbox/storefront/prs/11");
    expect(toHash(panelRoute(storefront, { tab: "agents", agent: "T1" }))).toBe("#/project/devbox/storefront/agents/T1");
  });

  it("opens Administration on People, and an older Settings › Machines link on its hub settings", () => {
    expect(toHash({ id: "admin", section: "invites" })).toBe("#/admin/invites");
    expect(parseHash("#/admin")).toEqual({ id: "admin", section: "people" });
    expect(parseHash("#/admin/nope")).toEqual({ id: "admin", section: "people" });
    expect(toHash({ id: "admin", section: "machines", machine: "laptop" })).toBe("#/admin/machines/laptop");
    expect(parseHash("#/admin/people/laptop")).toEqual({ id: "admin", section: "people" });
    expect(parseHash("#/settings/machines")).toEqual({ id: "admin", section: "hub" });
  });

  it("opens the Factory on the project a Status row links it to, else on every project", () => {
    expect(toHash({ id: "factory", project: null })).toBe("#/factory");
    expect(toHash({ id: "factory", project: storefront })).toBe("#/factory?project=devbox/storefront");
    expect(parseHash("#/factory?project=devbox/storefront")).toEqual({ id: "factory", project: storefront });
    // A project id may hold a slash; the machine is up to the first one.
    expect(parseHash("#/factory?project=devbox/a/b")).toEqual({ id: "factory", project: { machineId: "devbox", projectId: "a/b" } });
    for (const q of ["", "?project=", "?project=devbox", "?project=devbox/", "?project=/storefront", "?other=1"]) {
      expect(parseHash(`#/factory${q}`)).toEqual({ id: "factory", project: null });
    }
  });

  it("sends the removed surfaces, unknown and malformed hashes home", () => {
    for (const hash of ["", "#/board", "#/board/devbox/storefront", "#/order/W14?inbox&ask=A1", "#/inbox", "#/project/devbox", "#/prs", "#/prs/devbox/storefront", "#/agents", "#/agents/devbox/storefront/T1", "#/x", "#/project/%E0%A4%A/b"]) {
      expect(parseHash(hash)).toEqual(HOME);
    }
    expect(parseHash("#/status/project/devbox/storefront")).toEqual({ id: "status" });
    expect(parseHash("#/settings/nope")).toEqual({ id: "settings", tab: "general" });
    // A PR path that isn't one opens the project's list; an unknown panel, the chat alone.
    for (const tail of ["/0", "/x", "/acme/11", "/acme/storefront/x/11", ""]) {
      expect(parseHash(`#/project/devbox/storefront/prs${tail}`)).toEqual(panelRoute(storefront, { tab: "prs", pr: null }));
    }
    expect(parseHash("#/project/devbox/storefront/agents/T1/x")).toEqual(panelRoute(storefront, { tab: "agents", agent: null }));
    expect(parseHash("#/project/devbox/storefront/nope")).toEqual({ id: "project", project: storefront, message: null });
    // A tab without items ignores what follows its name.
    expect(parseHash("#/project/devbox/storefront/checklist/x")).toEqual(panelRoute(storefront, { tab: "checklist" }));
    for (const tab of ["train", "activity", "decisions"] as const) {
      expect(parseHash(`#/project/devbox/storefront/${tab}`)).toEqual(panelRoute(storefront, { tab }));
      expect(parseHash(`#/project/devbox/storefront/${tab}/12`)).toEqual(panelRoute(storefront, { tab }));
      expect(toHash(panelRoute(storefront, { tab }))).toBe(`#/project/devbox/storefront/${tab}`);
    }
  });

  it("gives every tab of the panel's list a route of its own name, its list with no item", () => {
    for (const tab of PANEL_TABS) {
      const route = panelRoute(storefront, listView(tab.id));
      expect(toHash(route)).toBe(`#/project/devbox/storefront/${tab.id}`);
      expect(parseHash(toHash(route))).toEqual(route);
      expect(hasItem(listView(tab.id))).toBe(false);
    }
    expect(hasItem({ tab: "prs", pr: { repo: null, number: 3 } })).toBe(true);
    expect(hasItem({ tab: "agents", agent: "T1" })).toBe(true);
    expect(hasItem({ tab: "sessions", session: "bs-checkout" })).toBe(true);
  });
});
