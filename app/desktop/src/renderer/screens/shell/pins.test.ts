// The sidebar's order: your pins on top in their order, then every other chat by its newest line, newest first; while
// the pointer is over the list (`held`), the unpinned rows stay where they were.
import { describe, expect, it } from "vitest";
import { arranged } from "./pins";

const row = (key: string, at: string, title = key) => ({ key, at: `2026-11-08T${at}:00.000Z`, project: { title } });
const keys = (r: ReadonlyArray<{ key: string }>) => r.map((x) => x.key);

const ROWS = [row("m/api", "09:00"), row("m/docs", "11:00"), row("m/web", "10:00"), row("m/new", "08:00")];

describe("the sidebar's order", () => {
  it("puts the newest first, then by title when two are as new", () => {
    expect(keys(arranged(ROWS, undefined))).toEqual(["m/docs", "m/web", "m/api", "m/new"]);
    expect(keys(arranged([row("m/b", "09:00", "beta"), row("m/a", "09:00", "Alpha")], []))).toEqual(["m/a", "m/b"]);
  });

  it("puts your pins on top in your order, whatever moves, and skips one that is gone", () => {
    expect(keys(arranged(ROWS, ["m/new", "m/gone", "m/api"]))).toEqual(["m/new", "m/api", "m/docs", "m/web"]);
  });

  it("holds the unpinned rows where they were while held, a new one after them, the pins still live", () => {
    const later = [row("m/api", "12:00"), row("m/docs", "11:00"), row("m/web", "10:00"), row("m/new", "08:00"), row("m/fresh", "13:00")];
    expect(keys(arranged(later, ["m/new"], ["m/docs", "m/web", "m/api"]))).toEqual(["m/new", "m/docs", "m/web", "m/api", "m/fresh"]);
    // Let go, they take their places.
    expect(keys(arranged(later, ["m/new"]))).toEqual(["m/new", "m/fresh", "m/api", "m/docs", "m/web"]);
  });
});
