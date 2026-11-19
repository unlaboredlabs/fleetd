import { describe, expect, it } from "vitest";
import { placeLine } from "./data";

describe("where a screen runs", () => {
  it("names its machine, quietly, and the agents' Mac as itself", () => {
    expect(placeLine({ kind: "ios", machine: "devbox" })).toBe("iOS simulator · devbox");
    expect(placeLine({ kind: "android", machine: "devbox" })).toBe("Android · devbox");
    expect(placeLine({ kind: "mac", machine: "mac1" })).toBe("Agents’ Mac");
  });
});
