// How chat text renders: markdown with machine tokens (ids, hashes, keys) set as code, and one-line text with its
// `code` runs. Shared by the messages and the told panel.
import { useMemo } from "react";
import { InlineCode, Markdown, Text, type TextProps } from "../../ui";
import { codeRuns, machineCode } from "./format";

/** A message in markdown, with its machine tokens set as code; parsed once per text. */
export function Message({ text }: { text: string }) {
  const source = useMemo(() => machineCode(text), [text]);
  return <Markdown source={source} />;
}

/** One line of words with its `code` runs set as code: no block markdown. */
export function InlineText(props: { text: string } & Omit<TextProps, "children">) {
  const { text, ...style } = props;
  const runs = useMemo(() => codeRuns(machineCode(text)), [text]);
  return (
    <Text {...style}>
      {runs.map((r, i) => (r.code ? <InlineCode key={i}>{r.text}</InlineCode> : r.text))}
    </Text>
  );
}
