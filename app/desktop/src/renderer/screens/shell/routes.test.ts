import { describe, expect, it } from "vitest";
import { HOME, parseHash, toHash, type Route } from "./routes";

const storefront = { machineId: "devbox", projectId: "storefront" };

describe("routes", () => {
  it("round-trips every screen, with and without the inbox open", () => {
    const routes: Array<Route> = [
      HOME,
      { screen: { id: "board", project: storefront }, inbox: null },
      { screen: { id: "order", orderId: "W14" }, inbox: { askId: "A1" } },
      { screen: { id: "status", scope: { kind: "fleet" } }, inbox: null },
      { screen: { id: "status", scope: { kind: "project", project: storefront } }, inbox: null },
      { screen: { id: "status", scope: { kind: "order", orderId: "W14" } }, inbox: { askId: null } },
      { screen: { id: "machines" }, inbox: null },
      { screen: { id: "time" }, inbox: null },
      { screen: { id: "projects.add" }, inbox: null },
      { screen: { id: "settings", tab: "prompts" }, inbox: null },
      { screen: { id: "onboarding", hub: "http://100.64.0.1:4790", code: "ABCD-2345" }, inbox: null },
      { screen: { id: "onboarding", hub: null, code: null }, inbox: null },
      { screen: { id: "gallery" }, inbox: null },
    ];
    for (const route of routes) expect(parseHash(toHash(route))).toEqual(route);
  });

  it("writes the hashes the screen writers and the QA registry use", () => {
    expect(toHash(HOME)).toBe("#/");
    expect(toHash({ screen: { id: "order", orderId: "W14" }, inbox: { askId: "A1" } })).toBe("#/order/W14?inbox&ask=A1");
    expect(toHash({ screen: { id: "settings", tab: "general" }, inbox: null })).toBe("#/settings/general");
    expect(toHash({ screen: { id: "board", project: { machineId: "dev box", projectId: "a/b" } }, inbox: null })).toBe(
      "#/board/dev%20box/a%2Fb",
    );
  });

  it("reads shorthands, and anything unknown or malformed as the board", () => {
    expect(parseHash("")).toEqual(HOME);
    expect(parseHash("#/inbox")).toEqual({ screen: HOME.screen, inbox: { askId: null } });
    expect(parseHash("#/settings")).toEqual({ screen: { id: "settings", tab: "general" }, inbox: null });
    expect(parseHash("#/settings/nope")).toEqual({ screen: { id: "settings", tab: "general" }, inbox: null });
    expect(parseHash("#/status/project/devbox")).toEqual({ screen: { id: "status", scope: { kind: "fleet" } }, inbox: null });
    expect(parseHash("#/order")).toEqual(HOME);
    expect(parseHash("#/whatever/else")).toEqual(HOME);
    expect(parseHash("#/order/%E0%A4%A")).toEqual(HOME);
  });
});
