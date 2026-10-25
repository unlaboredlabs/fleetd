// The project's PRs, open ones by default, merged ones or all a click away: each row its title, and under it, quietly,
// where it stands, its place in line, its checks and reviews, and its repo and number. A row opens the PR in the list's
// place; ↑ and ↓ move between rows.
import { useMemo, useState, type KeyboardEvent } from "react";
import type { ProjectRef } from "../../../shared/contracts";
import type { PrRow } from "../../../shared/contracts";
import { Button, StatusChip, Text, Truncate, VirtualList, cx } from "../../ui";
import { panelRoute, toHash } from "../shell/routes";
import { ChecksMark, HintText, PaneEmpty, Segmented } from "./Bits";
import { PR_FILTERS, emptyWords, filterCounts, listItems, rowMeta, type PrFilter } from "./listModel";
import { checksWord, isOpen, when } from "./words";
import s from "./prs.module.css";

// The reader's filter, kept while the app runs: back from a merged PR, the list still shows the merged ones.
let lastFilter: PrFilter = "open";

export const prHref = (project: ProjectRef, row: Pick<PrRow, "repo" | "number">): string =>
  toHash(panelRoute(project, { tab: "prs", pr: { repo: row.repo, number: row.number } }));

interface PrListProps {
  readonly rows: readonly PrRow[];
  /** The hub sent only the most recent. */
  readonly cut: boolean;
  readonly project: ProjectRef;
  readonly nowMs: number;
}

export function PrList({ rows, cut, project, nowMs }: PrListProps) {
  const [filter, setFilterState] = useState<PrFilter>(lastFilter);
  const setFilter = (next: PrFilter) => {
    lastFilter = next;
    setFilterState(next);
  };
  const counts = useMemo(() => filterCounts(rows), [rows]);
  const items = useMemo(() => listItems(rows, filter, cut), [rows, filter, cut]);
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
  const empty = items.length === 0 ? emptyWords(filter, counts) : undefined;
  return (
    <div className={s.list}>
      {rows.length > 0 ? (
        <div className={s.filters}>
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            options={PR_FILTERS.map((f) => ({ ...f, count: counts[f.value] > 0 ? counts[f.value] : undefined }))}
          />
        </div>
      ) : null}
      {empty !== undefined ? (
        <div className={s.listEmpty} data-empty={filter}>
          <PaneEmpty
            title={empty.title}
            action={
              empty.offer === undefined ? undefined : (
                <Button variant="secondary" size="sm" onClick={() => setFilter(empty.offer?.filter ?? "all")}>
                  {empty.offer.label}
                </Button>
              )
            }
          >
            {empty.body}
          </PaneEmpty>
        </div>
      ) : (
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
                  <Text size="xs" tone="faint" tabular>
                    {it.count}
                  </Text>
                </div>
              ) : it.kind === "cut" ? (
                <div className={s.cutNote}>
                  <Text size="xs" tone="faint">{`Only the ${it.count} most recent are here; the rest are on GitHub.`}</Text>
                </div>
              ) : (
                <Row row={it.row} project={project} nowMs={nowMs} />
              )
            }
          />
        </div>
      )}
    </div>
  );
}

function Row({ row, project, nowMs }: { row: PrRow; project: ProjectRef; nowMs: number }) {
  const meta = rowMeta(row);
  const at = row.mergedAt ?? row.updatedAt;
  const full = row.checks === undefined ? undefined : checksWord(row.checks)?.text;
  return (
    <a className={cx(s.row, !isOpen(row) && s.rowDone)} href={prHref(project, row)} data-pr={row.number}>
      <span className={s.rowTop}>
        <span className={s.rowTitle}>
          <Truncate lines={2} expand="none" tone="inherit">
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
        <span className={s.metaParts}>
          <StatusChip tone={meta.state.tone} inRow>
            {meta.state.word}
          </StatusChip>
          {meta.place !== undefined ? <HintText hint={{ text: meta.place, tone: "quiet" }} /> : null}
          {meta.checks !== undefined ? <ChecksMark hint={meta.checks} label={full} /> : null}
          {meta.review !== undefined ? <HintText hint={meta.review} /> : null}
        </span>
        <span className={s.rowRef}>
          <Text size="xs" tone="faint" tabular>
            {meta.ref}
          </Text>
        </span>
      </span>
    </a>
  );
}
