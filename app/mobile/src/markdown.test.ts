import { describe, expect, it } from "vitest";
import { fenceView, parseInline, parseMarkdown, previewText } from "./markdown";

describe("parseInline", () => {
  it("reads code, strong, emphasis and strikes", () => {
    expect(parseInline("a `x*y` **b** *c* _d_ ~~e~~")).toEqual([
      { t: "text", text: "a " },
      { t: "code", text: "x*y" },
      { t: "text", text: " " },
      { t: "strong", children: [{ t: "text", text: "b" }] },
      { t: "text", text: " " },
      { t: "em", children: [{ t: "text", text: "c" }] },
      { t: "text", text: " " },
      { t: "em", children: [{ t: "text", text: "d" }] },
      { t: "text", text: " " },
      { t: "del", children: [{ t: "text", text: "e" }] },
    ]);
  });

  it("leaves snake_case, lone stars and escapes as text", () => {
    expect(parseInline("run snake_case_name * 2 \\*not\\*")).toEqual([{ t: "text", text: "run snake_case_name * 2 *not*" }]);
  });

  it("links written and bare URLs, without the sentence's punctuation", () => {
    expect(parseInline("See [the docs](https://fleetd.sh/docs) or https://example.com/a_(b).")).toEqual([
      { t: "text", text: "See " },
      { t: "link", url: "https://fleetd.sh/docs", children: [{ t: "text", text: "the docs" }] },
      { t: "text", text: " or " },
      { t: "link", url: "https://example.com/a_(b)", children: [{ t: "text", text: "https://example.com/a_(b)" }] },
      { t: "text", text: "." },
    ]);
  });

  it("keeps a link of another scheme as its text", () => {
    expect(parseInline("[tap](javascript:alert(1))")).toEqual([
      { t: "text", text: "tap" },
      { t: "text", text: ")" },
    ]);
  });
});

describe("parseMarkdown", () => {
  it("reads paragraphs with their line breaks, headings, code and lists", () => {
    const blocks = parseMarkdown("# Done\nFirst line\nsecond line\n\n```sh\nnpm test\n```\n- one\n- two\n\n3. three\n4. four");
    expect(blocks).toEqual([
      { t: "h", level: 1, inline: [{ t: "text", text: "Done" }] },
      { t: "p", inline: [{ t: "text", text: "First line\nsecond line" }] },
      { t: "code", lang: "sh", text: "npm test" },
      { t: "list", ordered: false, start: 1, items: [[{ t: "text", text: "one" }], [{ t: "text", text: "two" }]] },
      { t: "list", ordered: true, start: 3, items: [[{ t: "text", text: "three" }], [{ t: "text", text: "four" }]] },
    ]);
  });

  it("reads quotes, rules and tables", () => {
    expect(parseMarkdown("> hi\n\n---\n| a | b |\n|---|---|\n| 1 | 2 |")).toEqual([
      { t: "quote", blocks: [{ t: "p", inline: [{ t: "text", text: "hi" }] }] },
      { t: "hr" },
      { t: "table", header: [[{ t: "text", text: "a" }], [{ t: "text", text: "b" }]], rows: [[[{ t: "text", text: "1" }], [{ t: "text", text: "2" }]]] },
    ]);
  });

  it("keeps an unclosed fence's code to the end", () => {
    expect(parseMarkdown("```\nstill streaming")).toEqual([{ t: "code", text: "still streaming" }]);
  });
});

describe("previewText", () => {
  it("is one line of plain text", () => {
    expect(previewText("**Done**: see `x`\n\n- a\n- b", { blocks: true })).toBe("Done: see x a, b");
  });
});

describe("fenceView", () => {
  it("is a quiet placeholder while a reply streams in, and the chip only once it's final", () => {
    const [block] = parseMarkdown('```fleetd-block\n{"v":1,"kind":"ima');
    const [code] = parseMarkdown('```json\n{"a":1}\n```');
    if (block === undefined || code === undefined) throw new Error("no blocks");
    // Still arriving: never "Couldn't show this", which the hub decides once the message is final.
    expect(fenceView(block, { blocks: true, streaming: true })).toBe("pending");
    expect(fenceView(block, { blocks: true })).toBe("unshown");
    expect(fenceView(code, { blocks: true, streaming: true })).toBe("code");
    expect(fenceView(code, { blocks: true })).toBe("code");
  });

  it("leaves a fleetd-block fence in a person's words as the code they wrote", () => {
    const [block] = parseMarkdown('```fleetd-block\n{"v":1,"kind":"ask","question":"Ship?"}\n```');
    if (block === undefined) throw new Error("no block");
    expect(fenceView(block, { blocks: false })).toBe("code");
    expect(fenceView(block, { blocks: false, streaming: true })).toBe("code");
    expect(previewText('try:\n\n```fleetd-block\n{"v":1}\n```', { blocks: false })).toBe('try: {"v":1}');
    expect(previewText('try:\n\n```fleetd-block\n{"v":1}\n```', { blocks: true })).toBe("try: Couldn't show this");
    // A lead's reply still streaming in: its block may still be arriving, so the preview leaves it out.
    expect(previewText('One more:\n\n```fleetd-block\n{"v":1,"ki', { blocks: true, streaming: true })).toBe("One more:");
  });
});
