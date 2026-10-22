import { describe, expect, it } from "vitest";
import { HOME, parseHash, toHash, type Screen } from "./routes";

const storefront = { machineId: "devbox", projectId: "storefront" };

describe("routes", () => {
  it("round-trips every screen", () => {
    const screens: Array<Screen> = [
      HOME,
      { id: "project", project: storefront, message: null },
      { id: "project", project: storefront, message: "m-42" },
      { id: "prs", project: storefront, pr: null },
      { id: "prs", project: storefront, pr: { repo: null, number: 11 } },
      { id: "prs", project: storefront, pr: { repo: "acme/storefront", number: 11 } },
      { id: "status" },
      { id: "agents", agent: null },
      { id: "agents", agent: { ...storefront, laneId: "lead:devbox/storefront" } },
      { id: "machines" },
      { id: "time", orderId: null },
      { id: "time", orderId: "W14" },
      { id: "projects.add" },
      { id: "settings", tab: "prompts" },
      { id: "onboarding", hub: "http://100.64.0.1:4790", code: "ABCD-2345" },
      { id: "onboarding", hub: null, code: null },
      { id: "gallery" },
    ];
    for (const screen of screens) expect(parseHash(toHash(screen))).toEqual(screen);
  });

  it("writes the hashes the screens and the QA registry use", () => {
    expect(toHash(HOME)).toBe("#/");
    expect(toHash({ id: "project", project: storefront, message: "m-42" })).toBe("#/project/devbox/storefront?message=m-42");
    expect(toHash({ id: "project", project: { machineId: "dev box", projectId: "a/b" }, message: null })).toBe("#/project/dev%20box/a%2Fb");
    expect(toHash({ id: "settings", tab: "general" })).toBe("#/settings/general");
    expect(toHash({ id: "prs", project: storefront, pr: null })).toBe("#/prs/devbox/storefront");
    expect(toHash({ id: "prs", project: storefront, pr: { repo: "acme/storefront", number: 11 } })).toBe("#/prs/devbox/storefront/acme/storefront/11");
    expect(toHash({ id: "prs", project: storefront, pr: { repo: null, number: 11 } })).toBe("#/prs/devbox/storefront/11");
    expect(toHash({ id: "agents", agent: { ...storefront, laneId: "T1" } })).toBe("#/agents/devbox/storefront/T1");
    expect(parseHash("#/agents/devbox")).toEqual({ id: "agents", agent: null });
  });

  it("sends the removed surfaces, unknown and malformed hashes home", () => {
    for (const hash of ["", "#/board", "#/board/devbox/storefront", "#/order/W14?inbox&ask=A1", "#/inbox", "#/project/devbox", "#/prs", "#/prs/devbox", "#/x", "#/project/%E0%A4%A/b"]) {
      expect(parseHash(hash)).toEqual(HOME);
    }
    expect(parseHash("#/status/project/devbox/storefront")).toEqual({ id: "status" });
    expect(parseHash("#/settings/nope")).toEqual({ id: "settings", tab: "general" });
    // A PR path that isn't one opens the project's list.
    for (const tail of ["/0", "/x", "/acme/11", "/acme/storefront/x/11", ""]) {
      expect(parseHash(`#/prs/devbox/storefront${tail}`)).toEqual({ id: "prs", project: storefront, pr: null });
    }
  });
});
