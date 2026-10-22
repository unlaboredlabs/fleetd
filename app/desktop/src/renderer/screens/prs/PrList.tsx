// The project's PRs, open ones first, then those merged or closed lately: each row its title and where it stands.
// A row opens the PR beside the list; ↑ and ↓ move between rows.
import { useMemo, type KeyboardEvent } from "react";
import type { ProjectRef } from "../../../shared/contracts";
import type { PrRow } from "../../src/data/pr-contract";
import { StatusChip, Text, Truncate, VirtualList, cx } from "../../ui";
import { toHash } from "../shell/routes";
import { checksWord, reviewsWord, stateLine, when } from "./words";
import s from "./prs.module.css";

type Item =
  | { readonly kind: "group"; readonly label: string; readonly count: number }
  | { readonly kind: "pr"; readonly row: PrRow }
  | { readonly kind: "cut"; readonly count: number };

const isOpen = (r: PrRow) => r.state === "open" || r.state === "draft";

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

export const prHref = (project: ProjectRef, row: Pick<PrRow, "repo" | "number">): string => toHash({ id: "prs", project, pr: { repo: row.repo, number: row.number } });

interface PrListProps {
  readonly rows: readonly PrRow[];
  /** The hub sent only the most recent. */
  readonly cut: boolean;
  readonly project: ProjectRef;
  readonly selected: { repo: string; number: number } | undefined;
  readonly nowMs: number;
}

export function PrList({ rows, cut, project, selected, nowMs }: PrListProps) {
  const items = useMemo(() => listItems(rows, cut), [rows, cut]);
  if (rows.length === 0) {
    return (
      <div className={s.paneNote}>
        <Text tone="quiet">No pull requests open or closed in the last week.</Text>
      </div>
    );
  }
  // ↑/↓ from a focused row moves to the row above or below and opens it, as in a mail list.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const links = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>("a[data-pr]")];
    const at = links.findIndex((a) => a === document.activeElement);
    if (at === -1) return;
    const next = links[at + (e.key === "ArrowDown" ? 1 : -1)];
    if (next === undefined) return;
    e.preventDefault();
    next.focus();
    next.click();
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
            <Row row={it.row} project={project} current={selected?.repo === it.row.repo && selected.number === it.row.number} nowMs={nowMs} />
          )
        }
      />
    </div>
  );
}

function Row({ row, project, current, nowMs }: { row: PrRow; project: ProjectRef; current: boolean; nowMs: number }) {
  const state = stateLine(row);
  // The state word already says the checks failed or are running for the merge; a closed PR's checks don't matter.
  const checksSaid = row.queue?.state === "ci_failed" || row.queue?.state === "ci";
  const checks = row.checks === undefined || checksSaid || !isOpen(row) ? undefined : checksWord(row.checks);
  const reviews = isOpen(row) ? reviewsWord(row.review) : undefined;
  // One hint: checks that failed or still run, else what the reviews say, else that the checks passed.
  const hint = checks !== undefined && checks.tone !== "done" ? checks : (reviews ?? checks);
  const at = row.mergedAt ?? row.updatedAt;
  return (
    <a className={cx(s.row, current && s.rowCurrent)} href={prHref(project, row)} data-pr={row.number} aria-current={current ? "page" : undefined}>
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
        {hint !== undefined ? (
          <Text size="xs" tone={hint.tone === "failed" ? "danger" : "quiet"}>
            {hint.text}
          </Text>
        ) : null}
      </span>
    </a>
  );
}
