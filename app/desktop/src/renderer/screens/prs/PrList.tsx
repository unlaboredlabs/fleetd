// The project's PRs, open ones first, then those merged or closed lately: each row its title, where it stands, its
// checks and reviews, and the agent that wrote it. A row opens the PR in the list's place; ↑ and ↓ move between rows.
import { useMemo, type KeyboardEvent } from "react";
import type { ProjectRef } from "../../../shared/contracts";
import type { PrRow } from "../../../shared/contracts";
import { StatusChip, Text, Truncate, VirtualList } from "../../ui";
import { panelRoute, toHash } from "../shell/routes";
import { authorWords, checksWord, isOpen, reviewsWord, stateLine, when } from "./words";
import s from "./prs.module.css";

type Item =
  | { readonly kind: "group"; readonly label: string; readonly count: number }
  | { readonly kind: "pr"; readonly row: PrRow }
  | { readonly kind: "cut"; readonly count: number };

/** Open PRs, then the rest, each under its heading; the hub's order within each. `cut`: the hub sent only these. */
export const listItems = (rows: readonly PrRow[], cut = false): Item[] => {
  const open = rows.filter(isOpen);
  const rest = rows.filter((r) => !isOpen(r));
  return [
    ...(open.length > 0 ? [{ kind: "group" as const, label: "Open", count: open.length }, ...open.map((row) => ({ kind: "pr" as const, row }))] : []),
    ...(rest.length > 0 ? [{ kind: "group" as const, label: "Merged or closed", count: rest.length }, ...rest.map((row) => ({ kind: "pr" as const, row }))] : []),
    ...(cut ? [{ kind: "cut" as const, count: rows.length }] : []),
  ];
};

export const prHref = (project: ProjectRef, row: Pick<PrRow, "repo" | "number">): string =>
  toHash(panelRoute(project, { tab: "prs", pr: { repo: row.repo, number: row.number } }));

/** Who wrote it, and the task it was asked for when that says more than the title: "A writer (high) · Round totals". */
export const byLine = (row: Pick<PrRow, "author" | "title">): string | undefined => {
  const who = authorWords(row.author);
  const task = row.author.title;
  const asked = task === undefined || task === "" || task === row.title ? undefined : task;
  return who === undefined ? asked : asked === undefined ? who : `${who} · ${asked}`;
};

interface PrListProps {
  readonly rows: readonly PrRow[];
  /** The hub sent only the most recent. */
  readonly cut: boolean;
  readonly project: ProjectRef;
  readonly nowMs: number;
}

export function PrList({ rows, cut, project, nowMs }: PrListProps) {
  const items = useMemo(() => listItems(rows, cut), [rows, cut]);
  if (rows.length === 0) {
    return (
      <div className={s.paneNote}>
        <Text tone="quiet">No pull requests open or closed in the last week.</Text>
      </div>
    );
  }
  // ↑/↓ from a focused row moves to the row above or below; Enter opens it.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const links = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>("a[data-pr]")];
    const at = links.findIndex((a) => a === document.activeElement);
    if (at === -1) return;
    const next = links[at + (e.key === "ArrowDown" ? 1 : -1)];
    if (next === undefined) return;
    e.preventDefault();
    next.focus();
  };
  return (
    <div className={s.listScroll} onKeyDown={onKeyDown}>
      <VirtualList
        items={items}
        getKey={(it) => (it.kind === "group" ? `group:${it.label}` : it.kind === "cut" ? "cut" : `${it.row.repo}#${it.row.number}`)}
        estimateSize={56}
        aria-label="Pull requests"
        renderItem={(it) =>
          it.kind === "group" ? (
            <div className={s.group}>
              <Text size="xs" tone="quiet" strong>
                {it.label}
              </Text>
              <Text size="xs" tone="quiet" tabular>
                {it.count}
              </Text>
            </div>
          ) : it.kind === "cut" ? (
            <div className={s.group}>
              <Text size="xs" tone="quiet">{`Only the ${it.count} most recent are here; the rest are on GitHub.`}</Text>
            </div>
          ) : (
            <Row row={it.row} project={project} nowMs={nowMs} />
          )
        }
      />
    </div>
  );
}

function Row({ row, project, nowMs }: { row: PrRow; project: ProjectRef; nowMs: number }) {
  const state = stateLine(row);
  // The state word already says the checks failed or are running for the merge; a closed PR's checks don't matter.
  const checksSaid = row.queue?.state === "ci_failed" || row.queue?.state === "ci";
  const checks = row.checks === undefined || checksSaid || !isOpen(row) ? undefined : checksWord(row.checks);
  const reviews = isOpen(row) ? reviewsWord(row.review) : undefined;
  const by = byLine(row);
  const at = row.mergedAt ?? row.updatedAt;
  return (
    <a className={s.row} href={prHref(project, row)} data-pr={row.number}>
      <span className={s.rowTop}>
        <span className={s.rowTitle}>
          <Truncate lines={2} expand="none">
            {row.title === "" ? `#${row.number}` : row.title}
          </Truncate>
        </span>
        <span className={s.rowWhen}>
          <Text size="xs" tone="faint" tabular>
            {when(at, nowMs || Date.parse(at))}
          </Text>
        </span>
      </span>
      <span className={s.rowMeta}>
        <Text size="xs" tone="quiet" tabular>
          #{row.number}
        </Text>
        <StatusChip tone={state.tone} inRow>
          {state.word}
        </StatusChip>
        {[checks, reviews].map((hint) =>
          hint === undefined ? null : (
            <Text key={hint.text} size="xs" tone={hint.tone === "failed" ? "danger" : "quiet"}>
              {hint.text}
            </Text>
          ),
        )}
      </span>
      {by !== undefined ? (
        <span className={s.rowBy}>
          <Truncate size="xs" tone="quiet" expand="none">
            {by}
          </Truncate>
        </span>
      ) : null}
    </a>
  );
}
