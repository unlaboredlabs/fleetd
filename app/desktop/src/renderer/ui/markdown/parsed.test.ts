// A block parses once: a row mounting again (a chat opened again, a message scrolled back into view) reuses its tree.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parsedBlock } from "./MarkdownBody";

describe("parsedBlock", () => {
  it("returns the same tree for the same text, and renders what react-markdown renders", () => {
    const md = "## Plan\n\n- **tests** first\n- then `the change`";
    const tree = parsedBlock(md, true);
    expect(parsedBlock(md, true)).toBe(tree);
    expect(renderToStaticMarkup(tree)).toContain("<strong>tests</strong>");
  });

  it("keeps a block with fleetd-block chips apart from the same words a person wrote", () => {
    const md = "```fleetd-block\n{}\n```";
    expect(parsedBlock(md, true)).not.toBe(parsedBlock(md, false));
  });

  it("keeps a chat's line breaks apart from the same text parsed without them", () => {
    const md = "first line\nsecond line";
    expect(parsedBlock(md, true, true)).not.toBe(parsedBlock(md, true));
    expect(renderToStaticMarkup(parsedBlock(md, true, true))).toContain("<br/>");
    expect(renderToStaticMarkup(parsedBlock(md, true))).not.toContain("<br/>");
  });

  it("keeps the newest blocks once it is full", () => {
    const first = parsedBlock("block 0", true);
    for (let i = 1; i <= 500; i++) parsedBlock(`block ${String(i)}`, true);
    expect(parsedBlock("block 500", true)).toBe(parsedBlock("block 500", true));
    expect(parsedBlock("block 0", true)).not.toBe(first);
  });
});
