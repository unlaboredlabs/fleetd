import { describe, expect, it } from "vitest";
import { timeRouteFor } from "./route";

describe("routes", () => {
  it("open the inspector on the order you're looking at, else on the fleet", () => {
    expect(timeRouteFor("#/factory/time/order/W8")).toBe("#/factory/time/order/W8");
    expect(timeRouteFor("#/time/order/W8")).toBe("#/factory/time/order/W8");
    expect(timeRouteFor("#/project/devbox/storefront")).toBe("#/factory/time");
    expect(timeRouteFor("")).toBe("#/factory/time");
  });
});
