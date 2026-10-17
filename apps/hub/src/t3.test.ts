import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { T3_PIN, missingExecutorRpcs } from "./t3.ts";

describe("pinned T3 wire contract", () => {
  it("serves every RPC the executor needs", () => {
    expect(missingExecutorRpcs()).toEqual([]);
  });

  it("reports operations a T3 build does not serve", () => {
    expect(missingExecutorRpcs({ requests: new Map() })).toContain("launch");
  });

  it("matches the vendored pin", () => {
    const pin = fs.readFileSync(new URL("../../../vendor/t3/PIN", import.meta.url), "utf8").trim();
    expect(T3_PIN).toBe(pin);
  });
});
