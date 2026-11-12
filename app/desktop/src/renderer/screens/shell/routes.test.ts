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
      panelRoute(storefront, { tab: "activity" }),
      panelRoute(storefront, { tab: "activity", dms: true }),
      panelRoute(storefront, { tab: "artifacts", artifact: null }),
      panelRoute(storefront, { tab: "artifacts", artifact: "dependency-sweep" }),
      panelRoute(storefront, { tab: "artifacts", artifact: "dependency-sweep", version: 2 }),
      { id: "project", project: storefront, message: "m-42", panel: { tab: "agents", agent: "T1" } },
      { id: "factory", project: null },
      { id: "factory", project: storefront },
      { id: "factory", project: { machineId: "dev box", projectId: "a/b" } },
      { id: "time", orderId: null },
      { id: "time", orderId: "W14" },
      { id: "projects.add" },
      { id: "settings", tab: "prompts" },
      { id: "settings", tab: "accounts" },
      { id: "settings", tab: "hubs" },
      { id: "settings", tab: "your-memory" },
      { id: "settings", tab: "prompts", prompt: "lead.start", for: "devbox/storefront" },
      { id: "settings", tab: "hub.people" },
      { id: "settings", tab: "hub.machines" },
      { id: "settings", tab: "hub.machines", machine: "laptop" },
      { id: "settings", tab: "hub.profiles" },
      { id: "settings", tab: "hub.tools" },
      { id: "settings", tab: "hub.instructions" },
      { id: "settings", tab: "hub.prompts" },
      { id: "settings", tab: "hub.prompts", prompt: "lead.start" },
      { id: "settings", tab: "hub.accounts" },
      { id: "settings", tab: "hub.setup" },
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
    // The PRs link is the chat's route plus /prs.
    expect(toHash(panelRoute(storefront, { tab: "prs", pr: null }))).toBe("#/project/devbox/storefront/prs");
    expect(toHash(panelRoute(storefront, { tab: "prs", pr: { repo: "acme/storefront", number: 11 } }))).toBe("#/project/devbox/storefront/prs/acme/storefront/11");
    expect(toHash(panelRoute(storefront, { tab: "prs", pr: { repo: null, number: 11 } }))).toBe("#/project/devbox/storefront/prs/11");
    expect(toHash(panelRoute(storefront, { tab: "agents", agent: "T1" }))).toBe("#/project/devbox/storefront/agents/T1");
  });

  it("writes the Hub group's pages under #/settings/hub", () => {
    expect(toHash({ id: "settings", tab: "hub.setup" })).toBe("#/settings/hub/setup");
    // Hub accounts is a part of Setup now: its link is still one, and still read.
    expect(toHash({ id: "settings", tab: "hub.accounts" })).toBe("#/settings/hub/accounts");
    expect(parseHash("#/settings/hub/accounts")).toEqual({ id: "settings", tab: "hub.accounts" });
    expect(toHash({ id: "settings", tab: "hub.machines", machine: "laptop" })).toBe("#/settings/hub/machines/laptop");
    expect(toHash({ id: "settings", tab: "hub.prompts", prompt: "lead.start" })).toBe("#/settings/hub/prompts?prompt=lead.start");
    // A link of before the prompt's compare and update views went still opens the prompt.
    expect(parseHash("#/settings/hub/prompts?prompt=lead.start&view=update")).toEqual({ id: "settings", tab: "hub.prompts", prompt: "lead.start" });
    expect(parseHash("#/settings/prompts?prompt=lead.start&for=devbox/storefront&view=compare")).toEqual({
      id: "settings",
      tab: "prompts",
      prompt: "lead.start",
      for: "devbox/storefront",
    });
    // Only the built-in prompts open one, and only Machines a machine.
    expect(parseHash("#/settings/hub/people?prompt=lead.start")).toEqual({ id: "settings", tab: "hub.people" });
    expect(parseHash("#/settings/hub/people/laptop")).toEqual({ id: "settings", tab: "hub.people" });
    expect(parseHash("#/settings/hub")).toEqual({ id: "settings", tab: "hub.people" });
    expect(parseHash("#/settings/hub/nope")).toEqual({ id: "settings", tab: "hub.people" });
    // A Hub page is no project's: a `for` is dropped, and a hub tab's name alone is no page.
    expect(parseHash("#/settings/hub/tools?for=devbox/storefront")).toEqual({ id: "settings", tab: "hub.tools" });
    expect(parseHash("#/settings/hub.people")).toEqual({ id: "settings", tab: "general" });
  });

  it("opens the Factory on one project, else on every project", () => {
    expect(toHash({ id: "factory", project: null })).toBe("#/factory");
    expect(toHash({ id: "factory", project: storefront })).toBe("#/factory?project=devbox/storefront");
    expect(parseHash("#/factory?project=devbox/storefront")).toEqual({ id: "factory", project: storefront });
    // A project id may hold a slash; the machine is up to the first one.
    expect(parseHash("#/factory?project=devbox/a/b")).toEqual({ id: "factory", project: { machineId: "devbox", projectId: "a/b" } });
    for (const q of ["", "?project=", "?project=devbox", "?project=devbox/", "?project=/storefront", "?other=1"]) {
      expect(parseHash(`#/factory${q}`)).toEqual({ id: "factory", project: null });
    }
  });

  it("opens Agent time as a tab of the Factory", () => {
    expect(toHash({ id: "time", orderId: null })).toBe("#/factory/time");
    expect(toHash({ id: "time", orderId: "W14" })).toBe("#/factory/time/order/W14");
    expect(parseHash("#/factory/time")).toEqual({ id: "time", orderId: null });
    expect(parseHash("#/factory/time/order/W14")).toEqual({ id: "time", orderId: "W14" });
    expect(parseHash("#/factory/time/nope")).toEqual({ id: "time", orderId: null });
  });

  it("sends the removed surfaces, unknown and malformed hashes home", () => {
    for (const hash of ["", "#/board", "#/board/devbox/storefront", "#/order/W14?inbox&ask=A1", "#/inbox", "#/project/devbox", "#/prs", "#/prs/devbox/storefront", "#/status", "#/status/project/devbox/storefront", "#/agents", "#/agents/devbox/storefront/T1", "#/time", "#/admin/people", "#/x", "#/project/%E0%A4%A/b"]) {
      expect(parseHash(hash)).toEqual(HOME);
    }
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
    for (const tab of PANEL_TABS.filter((t) => t.id !== "skills")) {
      const route = panelRoute(storefront, listView(tab.id));
      expect(toHash(route)).toBe(`#/project/devbox/storefront/${tab.id}`);
      expect(parseHash(toHash(route))).toEqual(route);
      expect(hasItem(listView(tab.id))).toBe(false);
    }
    expect(hasItem({ tab: "prs", pr: { repo: null, number: 3 } })).toBe(true);
    expect(hasItem({ tab: "agents", agent: "T1" })).toBe(true);
    expect(hasItem({ tab: "sessions", session: "bs-checkout" })).toBe(true);
    expect(hasItem({ tab: "artifacts", artifact: "dependency-sweep" })).toBe(true);
    // Skills is one skill only: an older link to their list opens them in the project's settings.
    const taxes = panelRoute(storefront, { tab: "skills", skill: "taxes" });
    expect(parseHash(toHash(taxes))).toEqual(taxes);
    expect(parseHash("#/project/devbox/storefront/skills")).toEqual({ id: "settings", tab: "agents", for: "devbox/storefront" });
    expect(toHash(panelRoute(storefront, { tab: "artifacts", artifact: "dependency-sweep", version: 2 }))).toBe("#/project/devbox/storefront/artifacts/dependency-sweep/2");
    // The lead chat's DM count opens Activity on its DMs log.
    expect(toHash(panelRoute(storefront, { tab: "activity", dms: true }))).toBe("#/project/devbox/storefront/activity/dms");
    expect(hasItem({ tab: "activity", dms: true })).toBe(false);
  });
});
