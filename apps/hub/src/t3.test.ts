import { describe, expect, it } from "vitest";
import { missingExecutorRpcs } from "./t3.ts";

describe("pinned T3 wire contract", () => {
  it("serves every RPC the executor needs", () => {
    expect(missingExecutorRpcs()).toEqual([]);
  });

  it("reports operations a T3 build does not serve", () => {
    expect(missingExecutorRpcs({ requests: new Map() })).toContain("launch");
  });
});
