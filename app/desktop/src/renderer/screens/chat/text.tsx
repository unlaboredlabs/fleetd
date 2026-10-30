// How chat text renders: markdown with machine tokens (ids, hashes, keys) set as code, and one-line text with its
// `code` runs. Shared by the messages and the told panel. With the project, its PR mentions are links that open the PR
// in the panel.
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

/**
 * A message in markdown, with its machine tokens set as code; parsed once per text. `blocks` (on unless a person wrote
 * it): its fleetd-block fences that reach here didn't show, so they are chips; a person's show as code.
 */
export function Message({ text, project, blocks = true }: { text: string; project?: ProjectKey | undefined; blocks?: boolean }) {
  const { machineId, projectId } = project ?? {};
  const md = useMemo(() => source(text, machineId, projectId), [text, machineId, projectId]);
  return <Markdown source={md} blocks={blocks} />;
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
