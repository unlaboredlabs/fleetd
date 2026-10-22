import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { markdownBlocks } from "./blocks";

// The newline react-markdown puts between two blocks is a text node that never renders, so it is left out.
const html = (source: string) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], skipHtml: true }, source)).replace(/>\n+</g, "><");
const byBlocks = (source: string) => markdownBlocks(source).map(html).join("");

// The shapes a lead writes, and the ones where a cut at a blank line would change what renders.
const REPLY = [
  "Here's the plan. Two agents are on it.",
  "## 1. Dates\n\nThe date wraps under the total on a narrow screen.\n\n- en-GB: 19 Oct 2026\n- de-DE: 19.10.2026",
  "A loose list stays one list:\n\n- first\n\n- second\n\n  with a second paragraph\n\n- third",
  "1. Add the amounts.\n\n2. Round once.\n\n3. Show each line rounded.",
  "```ts\nexport function roundTotal(cents: number): number {\n  const whole = Math.floor(cents);\n\n\n  return whole;\n}\n```",
  "~~~\nunindented after a blank, inside a tilde fence\n\nstill code\n~~~",
  "| Order | Before | After |\n| --- | --- | --- |\n| 3 × 0.335 | 1.02 | 1.01 |",
  "> The reviewer asked whether old receipts change.\n\n> They don't.",
  "    indented code\n\n    after a blank line",
  "- [x] dates\n- [ ] discounts\n\nText after the list.",
  "* a star list\n\n- then a dash list",
  "Setext heading\n===\n\n---\n\nLast paragraph, still being written and no newline yet",
].join("\n\n");

describe("markdownBlocks", () => {
  it("renders exactly as the whole message, at every point of a reply streaming in", () => {
    for (let end = 1; end <= REPLY.length; end += 7) {
      const prefix = REPLY.slice(0, end);
      expect(byBlocks(prefix), prefix).toBe(html(prefix));
    }
    expect(byBlocks(REPLY)).toBe(html(REPLY));
  });

  it("keeps every finished block's text while the reply grows, so only the last one redraws", () => {
    const whole = markdownBlocks(REPLY);
    expect(whole.length).toBeGreaterThan(10);
    for (let end = 1; end <= REPLY.length; end += 5) {
      const blocks = markdownBlocks(REPLY.slice(0, end));
      // The last block may still grow, and one before it can only be cut short by a line that isn't whole yet.
      expect(blocks.slice(0, -2)).toEqual(whole.slice(0, Math.max(0, blocks.length - 2)));
    }
  });

  it("cuts between paragraphs, headings, code and tables, never inside a fence or between one list's items", () => {
    expect(markdownBlocks("One.\n\n## Two\n\n```\na\n\nb\n```\n\n- x\n\n- y\n\nEnd")).toEqual(["One.", "## Two", "```\na\n\nb\n```", "- x\n\n- y", "End"]);
  });

  it("leaves a message whole when a definition or an HTML block can reach across blank lines", () => {
    for (const md of ["See [the docs][d].\n\nMore.\n\n[d]: https://fleetd.sh", "A note[^1].\n\nMore.\n\n[^1]: The footnote.", "<!--\n\nhidden\n\n-->\n\nShown."]) {
      expect(markdownBlocks(md)).toEqual([md]);
      expect(byBlocks(md)).toBe(html(md));
    }
  });
});
