// Hub sentences quote commands in backticks ("run `gh auth login` there"). They read as text with the commands set
// as inline code, never with the backticks showing.

import { InlineCode } from "../../ui";

/** Plain runs and `code` runs, in order. An unclosed backtick stays text. */
export const codeRuns = (text: string): ReadonlyArray<{ readonly code: boolean; readonly text: string }> => {
  const out: Array<{ code: boolean; text: string }> = [];
  let rest = text;
  for (;;) {
    const open = rest.indexOf("`");
    const close = open < 0 ? -1 : rest.indexOf("`", open + 1);
    if (open < 0 || close < 0 || close === open + 1) {
      if (rest !== "") out.push({ code: false, text: rest });
      return out;
    }
    if (open > 0) out.push({ code: false, text: rest.slice(0, open) });
    out.push({ code: true, text: rest.slice(open + 1, close) });
    rest = rest.slice(close + 1);
  }
};

/** Inline content: put it inside a <Text>. */
export function HubText({ children }: { children: string }) {
  return (
    <>
      {codeRuns(children).map((run, i) => (run.code ? <InlineCode key={i}>{run.text}</InlineCode> : run.text))}
    </>
  );
}
