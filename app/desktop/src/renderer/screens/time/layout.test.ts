// The timeline's layout, which lives in its stylesheet: what no model test can see.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(import.meta.dirname, "Time.module.css"), "utf8");
/** The declarations of one class's own rule. */
const rule = (name: string): Record<string, string> => {
  const body = new RegExp(`(?:^|\\n)\\.${name}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  return Object.fromEntries(body.split(";").flatMap((d) => (d.includes(":") ? [d.split(":").map((x) => x.trim()) as [string, string]] : [])));
};

describe("the timeline's layout", () => {
  it("keeps the critical path under the last lane, not stranded at the window's foot", () => {
    // The lanes' scroller takes the height its rows need, up to the room there is; it never grows past them.
    const flex = rule("scroller")["flex"]?.split(/\s+/);
    expect(flex?.[0]).toBe("0");
    expect(flex?.[1]).toBe("1");
    expect(rule("scroller")["min-height"]).toBe("0");
  });
});
