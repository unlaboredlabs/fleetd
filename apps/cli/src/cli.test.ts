import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { run } from "./cli.ts";

describe("fleetd cli", () => {
  it("prints its version", () => {
    expect(run(["--version"])).toEqual({ code: 0, stdout: `fleetd ${pkg.version} (protocol 1)\n`, stderr: "" });
  });

  it("exits 2 with usage on an unknown command", () => {
    const result = run(["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown command 'frobnicate'[\s\S]*usage: fleetd/);
  });
});
