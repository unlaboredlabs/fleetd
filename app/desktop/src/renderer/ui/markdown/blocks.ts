// Markdown cut into its top-level blocks, so a message streaming in parses and renders only its last block per
// delta: every block before it keeps the same text, and its memoized render (T3 Code renders streamed replies the
// same way). A cut is made only where CommonMark would end a block anyway, so the blocks render exactly as the whole.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
// What can reach across a blank line into a later block: a reference or footnote definition (used anywhere in the
// message), and the HTML blocks that only end at their closing tag. A message with one is left whole.
const WHOLE = /^ {0,3}(?:\[[^\]\n]+\]:|<(?:!--|(?:pre|script|style|textarea)\b))/im;

/**
 * The source's top-level blocks, in order, without the blank lines between them. A cut is made at a blank line outside
 * a fence, before a line that starts in column 0 and so cannot continue the block above it; never between the items of
 * one list.
 */
export function markdownBlocks(source: string): string[] {
  if (WHOLE.test(source)) return [source];
  const lines = source.split("\n");
  const blocks: string[] = [];
  let start = 0;
  let fence: { char: string; len: number } | null = null;
  let hasList = false;
  let blank = false;
  let seen = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (fence !== null) {
      const close = FENCE.exec(line);
      if (close?.[1]?.[0] === fence.char && close[1].length >= fence.len && line.trim() === close[1]) fence = null;
      continue;
    }
    if (line.trim() === "") {
      blank = true;
      continue;
    }
    const item = LIST_ITEM.test(line);
    if (blank && seen && !/^\s/.test(line) && !(item && hasList)) {
      blocks.push(lines.slice(start, i).join("\n").replace(/\n+$/, ""));
      start = i;
      hasList = false;
    }
    blank = false;
    seen = true;
    if (item) hasList = true;
    const open = FENCE.exec(line);
    if (open?.[1] !== undefined && !(open[1][0] === "`" && line.slice(open[0].length).includes("`"))) {
      fence = { char: open[1][0] ?? "`", len: open[1].length };
    }
  }
  blocks.push(lines.slice(start).join("\n"));
  return blocks;
}
