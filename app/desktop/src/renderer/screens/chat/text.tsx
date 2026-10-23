// How chat text renders: markdown with machine tokens (ids, hashes, keys) set as code, one-line text with its
// `code` runs, and a quiet disclosure line. Shared by the messages and the told panel. With the project, its PR
// mentions are links that open the PR in the panel.
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { InlineCode, Markdown, Text, type TextProps } from "../../ui";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import { codeRuns, machineCode, prLinks } from "./format";
import s from "./view.module.css";

const source = (text: string, machineId: string | undefined, projectId: string | undefined): string => {
  const md = machineCode(text);
  if (machineId === undefined || projectId === undefined) return md;
  return prLinks(md, (pr) => toHash(panelRoute({ machineId, projectId }, { tab: "prs", pr })));
};

/** A message in markdown, with its machine tokens set as code; parsed once per text. */
export function Message({ text, project }: { text: string; project?: ProjectKey | undefined }) {
  const { machineId, projectId } = project ?? {};
  const md = useMemo(() => source(text, machineId, projectId), [text, machineId, projectId]);
  return <Markdown source={md} />;
}

/** One line of words with its `code` runs set as code, and its PR links: no block markdown. */
export function InlineText(props: { text: string; project?: ProjectKey | undefined } & Omit<TextProps, "children">) {
  const { text, project, ...style } = props;
  const { machineId, projectId } = project ?? {};
  const runs = useMemo(() => codeRuns(source(text, machineId, projectId)), [text, machineId, projectId]);
  return (
    <Text {...style}>
      {runs.map((r, i) =>
        r.code ? (
          <InlineCode key={i}>{r.text}</InlineCode>
        ) : r.href !== undefined ? (
          <a key={i} className={s.link} href={r.href}>
            {r.text}
          </a>
        ) : (
          r.text
        ),
      )}
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
