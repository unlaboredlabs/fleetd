import { describe, expect, it } from "vitest";
import { orderRoute, timeRoute, timeRouteFor } from "./route";

describe("routes", () => {
  it("open the inspector on the order you're looking at, else on the fleet", () => {
    expect(timeRouteFor("#/order/W14?inbox")).toBe("#/time/order/W14");
    expect(timeRouteFor("#/status/order/W3")).toBe("#/time/order/W3");
    expect(timeRouteFor("#/time/order/W8")).toBe("#/time/order/W8");
    expect(timeRouteFor("#/board/devbox/storefront")).toBe("#/time");
    expect(timeRouteFor("")).toBe("#/time");
    expect(timeRoute("W8")).toBe("#/time/order/W8");
    expect(timeRoute()).toBe("#/time");
  });

  it("jump to a transcript item in the order view", () => {
    expect(orderRoute("W8", { threadId: "s-21", itemId: "toolu_1" })).toBe("#/order/W8?thread=s-21&item=toolu_1");
    expect(orderRoute("W8")).toBe("#/order/W8");
  });
});
