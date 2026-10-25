import { describe, expect, it } from "vitest";
import { barPath, compact, geometry, niceTicks } from "./chartModel";
import { fileOf, hunkLines } from "./diffBlock";

describe("a chart's geometry", () => {
  it("ticks round numbers from zero past the highest value", () => {
    expect(niceTicks(3, 17)).toEqual([0, 5, 10, 15, 20]);
    expect(niceTicks(-4, 6)).toEqual([-5, -2.5, 0, 2.5, 5, 7.5]);
    expect(niceTicks(0, 0)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(compact(1250)).toBe("1.25K");
    expect(compact(12_400)).toBe("12K");
    expect(compact(0.5)).toBe("0.5");
  });

  it("thins the x labels to what fits, keeping the last", () => {
    const x = Array.from({ length: 30 }, (_, i) => `Oct ${String(i + 1)}`);
    const g = geometry({ x, series: [{ name: "a", values: x.map((_, i) => i) }] }, 300, 180);
    expect(g.shownX[0]).toBe(0);
    expect(g.shownX.at(-1)).toBe(29);
    expect(g.shownX.length).toBeLessThan(10);
    const few = geometry({ x: ["Mon", "Tue", "Wed"], series: [{ name: "a", values: [1, 2, 3] }] }, 600, 180);
    expect(few.shownX).toEqual([0, 1, 2]);
    expect(few.y(0)).toBe(few.bottom);
  });

  it("draws a bar with a square foot on the baseline", () => {
    expect(barPath(10, 20, 100, 60)).toMatch(/^M10\.0,100\.0L10\.0,64\.0Q/);
    expect(barPath(10, 20, 100, 60)).toMatch(/L30\.0,100\.0Z$/);
  });
});

it("a diff block's hunks read as the PR view's numbered lines", () => {
  const lines = hunkLines(["@@ -10,3 +10,4 @@ export function total\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n\\ No newline at end of file\n"]);
  expect(lines.map((l) => `${l.kind}:${String(l.old ?? "")}:${String(l.new ?? "")}:${l.text}`)).toEqual([
    "hunk:10:10:export function total",
    "context:10:10:const a = 1;",
    "del:11::const b = 2;",
    "add::11:const b = 3;",
    "add::12:const c = 4;",
  ]);
  expect(fileOf({ path: "src/total.ts", hunks: [] }, lines)).toEqual({ path: "src/total.ts", additions: 2, deletions: 1, status: "modified" });
  expect(fileOf({ path: "new.ts", hunks: [] }, hunkLines(["@@ -0,0 +1,1 @@\n+hi"])).status).toBe("added");
});
