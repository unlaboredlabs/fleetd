// The Shipping list: the project's pull requests in one list. Those that need a look first, then what merges now (the
// merge train's head, a card: train/MergingNow), the line behind it in the train's order, the other open ones, and the
// merged and closed ones folded under their count; older ones a page at a time (Load more). Each row its title and,
// under it, quietly, where it stands, its checks and reviews; its repo, number and branch in its hover. A row opens the
// PR in the list's place; ↑ and ↓ move between rows. A row's right-click menu opens it here or on GitHub, or copies its
// URL or branch.
import type { Virtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, type ComponentProps, type KeyboardEvent } from "react";
import type { ProjectRef } from "../../../shared/contracts";
import type { PrRow } from "../../../shared/contracts";
import { Button, ContextMenu, ContextMenuCopy, ContextMenuItem, ContextMenuSeparator, Dot, Text, Tooltip, Truncate, VirtualList, cx, useArrivals, useArrived, useLeavers } from "../../ui";
import { FoldLine, GroupLabel, ListNote, PanelEmpty, useFold } from "../panel/folds";
import { panelRoute, toHash } from "../shell/routes";
import { MergingNow, type MovingNow } from "../train/MergingNow";
import { ChecksMark, HintText } from "./Bits";
import { openExternal } from "./PrDetail";
import { listItems, rowMeta, type Item } from "./listModel";
import { checksWord, isOpen, when } from "./words";
import s from "./prs.module.css";

const itemKey = (it: Item): string =>
  it.kind === "pr" ? `${it.row.repo}#${it.row.number}` : it.kind === "moving" ? `moving:${it.moving.prs.map((p) => p.changeId).join()}` : it.kind === "group" ? `group:${it.label}` : it.kind;

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
  /** What merges now (train/MergingNow's read). */
  readonly train: MovingNow;
  /** Opened at the merge line (`/train`, the palette's Go to Merge line): the list starts there. */
  readonly at?: "train" | null;
  readonly project: ProjectRef;
  readonly nowMs: number;
}

export function PrList({ rows, more, train, at = null, project, nowMs }: PrListProps) {
  const cut = more !== undefined;
  const key = `${project.machineId}/${project.projectId}`;
  const [rest, toggleRest] = useFold(`prs:${key}:rest`);
  useArrivals(`prs:${key}`, rows.map((r) => `${r.repo}#${r.number}`));
  const items = useMemo(() => listItems(rows, { moving: train.moving, rest, cut }), [rows, train.moving, rest, cut]);
  // Folding is a new view, not rows leaving: its rows go at once, with no fade.
  const shown = useLeavers(items, itemKey, `${key}:${String(rest)}`);
  // ↑/↓ from a focused row moves to the row above or below; Enter opens it.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const links = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>("a[data-pr]")];
    const from = links.findIndex((a) => a === document.activeElement);
    if (from === -1) return;
    const next = links[from + (e.key === "ArrowDown" ? 1 : -1)];
    if (next === undefined) return;
    e.preventDefault();
    next.focus();
  };

  // A link to the merge line opens the list at what merges now, else at the line.
  const list = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const lineAt = shown?.findIndex((x) => x.item.kind === "group" && (x.item.label === "Merging now" || x.item.label === "In line")) ?? -1;
  const there = at === "train" && lineAt >= 0;
  useEffect(() => {
    if (there) list.current?.scrollToIndex(lineAt, { align: "start" });
    // Only as the link opens it: the list then scrolls as the reader does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [there]);

  return (
    <div className={s.list}>
      {train.state === "error" ? (
        <span className={s.liveness} role="alert">
          <Dot color="var(--warning)" />
          <Text size="xs">Couldn’t read what merges now</Text>
          <Button variant="quiet" size="sm" onClick={train.retry}>
            Retry
          </Button>
        </span>
      ) : null}
      {items.length === 0 ? (
        <PanelEmpty title="No pull requests yet" actions={more !== undefined ? <LoadMore more={more} /> : undefined} />
      ) : (
        <div className={s.listScroll} onKeyDown={onKeyDown}>
          <VirtualList
            items={shown ?? []}
            getKey={(x) => itemKey(x.item)}
            estimateSize={62}
            virtualizerRef={list}
            aria-label="Pull requests"
            renderItem={({ item: it, leaving }) => {
              const row =
                it.kind === "group" ? (
                  <GroupLabel label={it.label} count={it.count} />
                ) : it.kind === "fold" ? (
                  <FoldLine label={it.label} count={it.count} open={rest} onToggle={toggleRest} />
                ) : it.kind === "moving" ? (
                  <MergingNow moving={it.moving} repo={it.repo} project={project} nowMs={nowMs || undefined} />
                ) : it.kind === "note" ? (
                  <ListNote>{it.text}</ListNote>
                ) : it.kind === "cut" ? (
                  more !== undefined ? <LoadMore more={more} /> : null
                ) : (
                  <Row row={it.row} project={project} nowMs={nowMs} />
                );
              // A PR that left its place (merged out of the line, say) fades where it stood (ui/lib/leaving), then goes.
              return leaving ? (
                <div data-leaving="" inert aria-hidden>
                  {row}
                </div>
              ) : (
                row
              );
            }}
          />
        </div>
      )}
    </div>
  );
}

/** Older PRs to read: under the rows, or under an empty list, since the older ones may hold its PRs. */
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
      <RowLink row={row} nowMs={nowMs} className={cx(s.row, !isOpen(row) && s.rowDone, fresh && s.arrive)} href={href} data-pr={row.number} />
    </ContextMenu>
  );
}

/** The row itself, which takes what the menu's trigger hands it; its repo, number, branch and why it waits are its hover's. */
function RowLink({ row, nowMs, ...rest }: { row: PrRow; nowMs: number } & ComponentProps<"a">) {
  const meta = rowMeta(row);
  const at = row.mergedAt ?? row.updatedAt;
  const full = row.checks === undefined ? undefined : checksWord(row.checks)?.text;
  const name = row.branch === undefined ? meta.ref : `${meta.ref} · ${row.branch}`;
  const detail =
    meta.why === undefined ? (
      name
    ) : (
      <>
        {meta.why}
        <br />
        {name}
      </>
    );
  return (
    <Tooltip content={detail} side="left">
      <a {...rest}>
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
        <span className={s.metaParts}>
          {meta.state.word === "open" ? null : (
            <span className={s.stateWord} data-tone={meta.state.tone}>
              {meta.state.word}
            </span>
          )}
          {meta.checks !== undefined ? <ChecksMark hint={meta.checks} label={full} /> : null}
          {meta.review !== undefined ? <HintText hint={meta.review} /> : null}
        </span>
      </a>
    </Tooltip>
  );
}
