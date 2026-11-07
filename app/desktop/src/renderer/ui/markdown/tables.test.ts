// Tables' cell wrapping, which lives in the stylesheets: what no model test can see. `overflow-wrap: anywhere` lets
// a cell's min-content width shrink to one letter, so auto layout crushed short columns ("Siz/e", "ye/s") to give the
// long ones room; cells wrap only between words, and a table wider than its pane scrolls sideways instead.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The declarations of the rule whose selector list is exactly `selector`. */
const rule = (file: URL, selector: string): Record<string, string> => {
  const css = readFileSync(file, "utf8");
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} in ${file.pathname}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries(body.split(";").flatMap((d) => (d.includes(":") ? [d.split(":").map((x) => x.trim()) as [string, string]] : [])));
};

const markdown = new URL("./Markdown.module.css", import.meta.url);
const blocks = new URL("../../screens/chat/blocks/blocks.module.css", import.meta.url);

describe("tables", () => {
  for (const [name, file, cells, scroller] of [
    ["a Markdown table (reports, messages)", markdown, ".root th,\n.root td", ".tableWrap"],
    ["a table block", blocks, ".table th,\n.table td", ".tableScroll"],
  ] as const) {
    it(`${name} never breaks a word inside, and scrolls when it is wider than its pane`, () => {
      const cell = rule(file, cells);
      expect(cell["overflow-wrap"]).toBe("normal");
      expect(cell["word-break"]).toBe("normal");
      expect(rule(file, scroller)["overflow-x"]).toBe("auto");
    });
  }

  it("keeps a Markdown cell's `code` whole too, over inline code's own `anywhere`", () => {
    expect(rule(markdown, ".root :is(th, td) code")["overflow-wrap"]).toBe("normal");
  });
});
