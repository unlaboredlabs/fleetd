import { describe, expect, it } from "vitest";
import { HOME, panelRoute, parseHash, toHash, type Screen } from "./routes";

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
      { id: "project", project: storefront, message: "m-42", panel: { tab: "agents", agent: "T1" } },
      { id: "status" },
      { id: "machines" },
      { id: "time", orderId: null },
      { id: "time", orderId: "W14" },
      { id: "projects.add" },
      { id: "settings", tab: "prompts" },
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
  });
});
