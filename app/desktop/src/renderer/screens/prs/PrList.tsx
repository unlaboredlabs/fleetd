// The project's PRs, open ones by default, merged ones or all a click away: each row its title, and under it, quietly,
// where it stands, its place in line, its checks and reviews, and its repo and number, a page at a time (Load more). A
// row opens the PR in the list's place; ↑ and ↓ move between rows. A row's right-click menu opens it here or on GitHub,
// or copies its URL or branch.
import { useMemo, useState, type KeyboardEvent } from "react";
import type { ProjectRef } from "../../../shared/contracts";
import type { PrRow } from "../../../shared/contracts";
import { Button, ContextMenu, ContextMenuCopy, ContextMenuItem, ContextMenuSeparator, Text, Truncate, VirtualList, cx, useArrivals, useArrived } from "../../ui";
import { panelRoute, toHash } from "../shell/routes";
import { ChecksMark, HintText, PaneEmpty, Segmented } from "./Bits";
import { openExternal } from "./PrDetail";
import { PR_FILTERS, emptyWords, filterCounts, listItems, rowMeta, type PrFilter } from "./listModel";
import { checksWord, isOpen, when } from "./words";
import s from "./prs.module.css";

// The reader's filter per project, kept while the app runs: back from a merged PR, the list still shows the merged
// ones, and another project's list opens on its own.
const lastFilter = new Map<string, PrFilter>();

/** Forgets every project's filter (tests start from the default). */
export const forgetFilters = (): void => lastFilter.clear();

export const prHref = (project: ProjectRef, row: Pick<PrRow, "repo" | "number">): string =>
  toHash(panelRoute(project, { tab: "prs", pr: { repo: row.repo, number: row.number } }));

/** Older PRs past these: read them, while it reads, and why the last read failed. */
export interface More {
  readonly load: () => void;
  readonly loading: boolean;
  readonly error?: string;
}

interface PrListProps {
  readonly rows: readonly PrRow[];
  /** There are older PRs past these. */
  readonly more: More | undefined;
  readonly project: ProjectRef;
  readonly nowMs: number;
}

export function PrList({ rows, more, project, nowMs }: PrListProps) {
  const cut = more !== undefined;
  const key = `${project.machineId}/${project.projectId}`;
  const [filter, setFilterState] = useState<PrFilter>(() => lastFilter.get(key) ?? "open");
  const setFilter = (next: PrFilter) => {
    lastFilter.set(key, next);
    setFilterState(next);
  };
  const counts = useMemo(() => filterCounts(rows), [rows]);
  useArrivals(`prs:${key}`, rows.map((r) => `${r.repo}#${r.number}`));
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
          {more !== undefined ? <LoadMore more={more} /> : null}
        </div>
      ) : (
        <div className={s.listScroll} onKeyDown={onKeyDown}>
          <VirtualList
            items={items}
            getKey={(it) => (it.kind === "group" ? `group:${it.label}` : it.kind === "cut" ? "cut" : `${it.row.repo}#${it.row.number}`)}
            estimateSize={78}
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
                more !== undefined ? <LoadMore more={more} /> : null
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

/** Older PRs to read: under the rows, or under an empty filter, since the older ones may hold its PRs. */
function LoadMore({ more }: { more: More }) {
  return (
    <div className={s.cutNote}>
      <Button variant="quiet" size="sm" onClick={more.load} disabled={more.loading}>
        {more.loading ? "Loading…" : "Load more"}
      </Button>
      {more.error !== undefined ? (
        <span role="alert">
          <Text size="xs" tone="danger">
            {more.error}
          </Text>
        </span>
      ) : null}
    </div>
  );
}

function Row({ row, project, nowMs }: { row: PrRow; project: ProjectRef; nowMs: number }) {
  const meta = rowMeta(row);
  const at = row.mergedAt ?? row.updatedAt;
  const full = row.checks === undefined ? undefined : checksWord(row.checks)?.text;
  const href = prHref(project, row);
  const branch = row.branch;
  const fresh = useArrived(`prs:${project.machineId}/${project.projectId}`, `${row.repo}#${row.number}`);
  const menu = () => (
    <>
      <ContextMenuItem onSelect={() => (window.location.hash = href)}>Open</ContextMenuItem>
      <ContextMenuItem onSelect={() => openExternal(row.url)}>Open on GitHub</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuCopy text={row.url}>Copy URL</ContextMenuCopy>
      {branch !== undefined ? <ContextMenuCopy text={branch}>Copy branch</ContextMenuCopy> : null}
    </>
  );
  return (
    <ContextMenu menu={menu}>
      <a className={cx(s.row, !isOpen(row) && s.rowDone, fresh && s.arrive)} href={href} data-pr={row.number}>
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
            <span className={s.stateWord} data-tone={meta.state.tone}>
              {meta.state.word}
            </span>
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
    </ContextMenu>
  );
}
