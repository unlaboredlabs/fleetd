import { describe, expect, it } from "vitest";
import { timeRouteFor } from "./route";

describe("routes", () => {
  it("open the inspector on the order you're looking at, else on the fleet", () => {
    expect(timeRouteFor("#/time/order/W8")).toBe("#/time/order/W8");
    expect(timeRouteFor("#/project/devbox/storefront")).toBe("#/time");
    expect(timeRouteFor("")).toBe("#/time");
  });
});
