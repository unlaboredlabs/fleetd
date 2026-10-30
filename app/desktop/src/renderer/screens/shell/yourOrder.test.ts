// Your sidebar order: the rows it names in its order, new ones after in the sidebar's own; a move in one section saved
// with the other section as it is.
import { describe, expect, it } from "vitest";
import { ordered, withMoved } from "./yourOrder";

const rows = (...keys: string[]) => keys.map((key) => ({ key }));
const keys = (r: ReadonlyArray<{ key: string }>) => r.map((x) => x.key);

describe("your order", () => {
  it("puts the rows it names first, as it names them, and the new ones at the end in their own order", () => {
    expect(keys(ordered(rows("m/api", "m/docs", "m/web", "m/new"), ["m/web", "m/api", "m/docs"]))).toEqual(["m/web", "m/api", "m/docs", "m/new"]);
    expect(keys(ordered(rows("m/a", "m/b", "m/c"), ["m/c"]))).toEqual(["m/c", "m/a", "m/b"]);
  });

  it("leaves the sidebar's own order with none, and skips what is gone", () => {
    expect(keys(ordered(rows("m/a", "m/b"), undefined))).toEqual(["m/a", "m/b"]);
    expect(keys(ordered(rows("m/a", "m/b"), []))).toEqual(["m/a", "m/b"]);
    expect(keys(ordered(rows("m/a", "m/b"), ["m/gone", "m/b"]))).toEqual(["m/b", "m/a"]);
  });

  it("saves a move in one section with the other where it is", () => {
    // Two Navis, then three projects; the projects moved.
    const hub = rows("m/ada", "m/home", "m/api", "m/docs", "m/web");
    expect(keys(withMoved(hub, ["m/web", "m/api", "m/docs"]))).toEqual(["m/ada", "m/home", "m/web", "m/api", "m/docs"]);
    expect(keys(withMoved(hub, ["m/home", "m/ada"]))).toEqual(["m/home", "m/ada", "m/api", "m/docs", "m/web"]);
  });
});
