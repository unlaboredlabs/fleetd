import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureMeta } from "./harness.ts";

describe("fixtureMeta", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fleetd-qa-meta-"));
  const file = (name: string, body: object) => {
    const f = path.join(dir, `${name}.json`);
    writeFileSync(f, JSON.stringify(body));
    return f;
  };

  it("reads the clock and how long the timed frames run", () => {
    expect(fixtureMeta(file("timed", { now: "2026-10-19T08:15:00Z", settleMs: 3000 }))).toEqual({
      now: "2026-10-19T08:15:00Z",
      settleMs: 3000,
    });
  });

  it("settles at once without timed frames", () => {
    expect(fixtureMeta(file("static", { now: "2026-10-19T08:15:00Z" })).settleMs).toBe(0);
  });

  it("names the fix when the fixture was never built", () => {
    expect(() => fixtureMeta(path.join(dir, "missing.json"))).toThrow(/pnpm fixtures/);
  });
});
