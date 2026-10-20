// How chat text renders: markdown with machine tokens (ids, hashes, keys) set as code, one-line text with its
// `code` runs, and a quiet disclosure line. Shared by the messages and the told panel.
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { InlineCode, Markdown, Text, type TextProps } from "../../ui";
import { codeRuns, machineCode } from "./format";
import s from "./view.module.css";

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

export function Disclosure(props: { open: boolean; onToggle: () => void; children: string }) {
  const Icon = props.open ? ChevronDown : ChevronRight;
  return (
    <button type="button" className={s.disclosure} aria-expanded={props.open} onClick={props.onToggle}>
      <Icon className={s.chevron} aria-hidden />
      <Text size="xs" tone="inherit">
        {props.children}
      </Text>
    </button>
  );
}
