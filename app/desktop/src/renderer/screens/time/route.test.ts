import { describe, expect, it } from "vitest";
import { chatRoute, timeRoute, timeRouteFor } from "./route";

describe("routes", () => {
  it("open the inspector on the order you're looking at, else on the fleet", () => {
    expect(timeRouteFor("#/order/W14?inbox")).toBe("#/time/order/W14");
    expect(timeRouteFor("#/time/order/W8")).toBe("#/time/order/W8");
    expect(timeRouteFor("#/board/devbox/storefront")).toBe("#/time");
    expect(timeRouteFor("")).toBe("#/time");
    expect(timeRoute("W8")).toBe("#/time/order/W8");
    expect(timeRoute()).toBe("#/time");
  });

  it("goes from one piece of work to its project's chat", () => {
    expect(chatRoute({ machineId: "devbox", projectId: "storefront" })).toBe("#/project/devbox/storefront");
    expect(chatRoute(undefined)).toBe("#/");
  });
});
