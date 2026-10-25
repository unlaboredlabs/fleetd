// A PR's changes: the files on the left, the diff on the right. Both lists draw only the rows on screen. Files come a
// page at a time as the list reaches them; each file's lines a page at a time as they scroll into view, then get
// their syntax colours. One column or side by side; a file folds from its header.
import type { Virtualizer } from "@tanstack/react-virtual";
import { ChevronDown } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useToolPages, useToolQueries } from "../../src/data/react";
import type { DiffLine, PrDiffOutput, PrFile } from "../../../shared/contracts";
import { Button, Text, Truncate, VirtualList, cx, renderTokens } from "../../ui";
import { DIFF_PAGE, diffRows, fileRowIndex, hunkText, sidesOf, statusWords, type DiffMode, type DiffRow, type Page, type Pages } from "./diffModel";
import { usePageTokens } from "./tokens";
import { stat } from "./words";
import s from "./prs.module.css";

// The layout is the reader's, kept while the app runs, so every PR opens the way the last one was read.
let lastMode: DiffMode = "unified";

/**
 * Pages of lines kept subscribed: the ones scrolled through last. An event refetches each subscribed page, so this
 * bounds that; a page dropped from it is read again from the cache when it is drawn again.
 */
const MAX_PAGES = 40;

interface Want {
  readonly path: string;
  readonly offset: number;
}

const pageObjects = new WeakMap<PrDiffOutput, Page>();
const pageOf = (path: string, offset: number, out: PrDiffOutput): Page => {
  let page = pageObjects.get(out);
  if (page === undefined) {
    page = { path, offset, lines: out.lines };
    pageObjects.set(out, page);
  }
  return page;
};

export interface DiffPaneProps {
  readonly repo: string;
  readonly number: number;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
  /** GitHub wasn't reached, so an empty list means unknown rather than nothing changed. */
  readonly githubDown?: boolean;
}

export function DiffPane({ repo, number, additions, deletions, githubDown = false }: DiffPaneProps) {
  const filesQuery = useToolPages("pr_files", { repo, number }, (page) => (page.nextOffset === undefined ? undefined : { offset: page.nextOffset }));
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = filesQuery;
  const files = useMemo(() => filesQuery.data?.pages.flatMap((p) => p.files) ?? [], [filesQuery.data]);
  const total = filesQuery.data?.pages.at(-1)?.total ?? files.length;

  const [mode, setMode] = useState<DiffMode>(lastMode);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [wanted, setWanted] = useState<readonly Want[]>([]);
  const [selected, setSelected] = useState<number>();

  const inputs = useMemo(() => wanted.map((w) => ({ repo, number, path: w.path, offset: w.offset, limit: DIFF_PAGE })), [wanted, repo, number]);
  const results = useToolQueries("pr_diff", inputs);
  // A new answer for any page changes this, and only that rebuilds the rows.
  const loadedKey = results.map((r) => `${r.dataUpdatedAt}:${r.status}`).join(",");
  const { pages, failed } = useMemo(() => {
    const pages: Map<string, Map<number, Page>> = new Map();
    const failed = new Set<string>();
    results.forEach((r, i) => {
      const w = wanted[i];
      if (w === undefined) return;
      if (r.data !== undefined) {
        let byOffset = pages.get(w.path);
        if (byOffset === undefined) {
          byOffset = new Map();
          pages.set(w.path, byOffset);
        }
        byOffset.set(w.offset, pageOf(w.path, w.offset, r.data));
      } else if (r.isError) failed.add(`${w.path}\u0000${w.offset}`);
    });
    const loaded: Pages = pages;
    return { pages: loaded, failed };
    // `results` is a new array every render; its answers are what `loadedKey` says.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKey, wanted]);

  const rows = useMemo(() => diffRows({ files, total, pages, mode, folded }), [files, total, pages, mode, folded]);
  const headers = useMemo(() => fileRowIndex(rows), [rows]);

  const want = useCallback((path: string, offset: number) => {
    setWanted((w) => (w.some((x) => x.path === path && x.offset === offset) ? w : [...w, { path, offset }].slice(-MAX_PAGES)));
  }, []);
  // Read through a ref, so `retry` keeps one identity and the rows' memo holds.
  const latest = useRef({ wanted, results });
  useEffect(() => {
    latest.current = { wanted, results };
  });
  const retry = useCallback((path: string, offset: number) => {
    const { wanted: w, results: r } = latest.current;
    void r[w.findIndex((x) => x.path === path && x.offset === offset)]?.refetch();
  }, []);
  const toggle = useCallback((path: string) => {
    setFolded((f) => {
      const next = new Set(f);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }, []);
  const more = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const diff = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const jump = (file: number) => {
    setSelected(file);
    const at = headers.get(file);
    if (at !== undefined) diff.current?.scrollToIndex(at, { align: "start" });
  };

  const switchMode = () => {
    const next = mode === "unified" ? "split" : "unified";
    lastMode = next;
    setMode(next);
  };

  if (filesQuery.isError && files.length === 0) {
    return (
      <div className={s.paneNote} role="alert">
        <Text tone="quiet">Couldn’t load the changed files.</Text>
        <Button onClick={() => void filesQuery.refetch()}>Retry</Button>
      </div>
    );
  }
  if (filesQuery.data === undefined) {
    return (
      <div className={s.paneNote} aria-busy="true">
        <Text tone="quiet">Loading the changes…</Text>
      </div>
    );
  }
  if (total === 0) {
    return (
      <div className={s.paneNote}>
        <Text tone="quiet">{githubDown ? "The changed files aren’t known: GitHub wasn’t reached." : "No files changed."}</Text>
      </div>
    );
  }

  return (
    <div className={s.changes} data-diff-mode={mode}>
      <div className={s.changesBar}>
        <Text size="xs" tone="quiet" tabular>
          {total === 1 ? "1 file" : `${total} files`}
          {additions !== undefined && deletions !== undefined ? (
            <>
              {" · "}
              <span className={s.add}>+{stat(additions)}</span> <span className={s.del}>−{stat(deletions)}</span>
            </>
          ) : null}
        </Text>
        <Button variant="quiet" onClick={switchMode} aria-label={mode === "unified" ? "Show side by side" : "Show in one column"}>
          {mode === "unified" ? "Side by side" : "One column"}
        </Button>
      </div>
      <div className={s.changesBody}>
        <nav className={s.fileList} aria-label="Changed files" data-text="code">
          <VirtualList
            items={files}
            getKey={(f, i) => `${i}\u0000${f.path}`}
            estimateSize={28}
            renderItem={(f, i) => <FileItem f={f} current={selected === i} onPick={() => jump(i)} onEnd={i === files.length - 1 ? more : undefined} />}
            aria-label="Changed files"
          />
        </nav>
        <div className={s.diff} data-text="code" aria-busy={results.some((r) => r.isPending && r.fetchStatus === "fetching") ? "true" : undefined}>
          <VirtualList
            items={rows}
            getKey={(r) => r.key}
            estimateSize={20}
            overscan={40}
            virtualizerRef={diff}
            role="presentation"
            renderItem={(r) => <Row row={r} mode={mode} want={want} retry={retry} failed={failed} toggle={toggle} more={more} />}
            aria-label="Changes"
          />
        </div>
      </div>
    </div>
  );
}

function FileItem({ f, current, onPick, onEnd }: { f: PrFile; current: boolean; onPick: () => void; onEnd: (() => void) | undefined }) {
  // The last file listed asks for the next page of files once it is drawn.
  useEffect(() => onEnd?.(), [onEnd]);
  const name = f.path.split("/").pop() ?? f.path;
  const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/u, "");
  return (
    <button type="button" className={cx(s.fileItem, current && s.fileCurrent)} onClick={onPick} aria-current={current ? "true" : undefined} title={f.path}>
      <span className={s.fileName}>
        <Truncate size="sm" expand="none">
          {name}
        </Truncate>
        {dir !== "" ? (
          <Truncate size="xs" tone="quiet" expand="none">
            {dir}
          </Truncate>
        ) : null}
      </span>
      <span className={s.fileStat}>
        <span className={s.add}>+{stat(f.additions)}</span>
        <span className={s.del}>−{stat(f.deletions)}</span>
      </span>
    </button>
  );
}

interface RowProps {
  readonly row: DiffRow;
  readonly mode: DiffMode;
  readonly want: (path: string, offset: number) => void;
  readonly retry: (path: string, offset: number) => void;
  readonly failed: ReadonlySet<string>;
  readonly toggle: (path: string) => void;
  readonly more: () => void;
}

const Row = memo(function Row({ row, mode, want, retry, failed, toggle, more }: RowProps): ReactNode {
  switch (row.kind) {
    case "file":
      return <FileHeader f={row.f} open={row.open} toggle={toggle} />;
    case "hunk":
      return <HunkRow line={row.line} />;
    case "line":
      return <LineRow page={row.page} line={row.line} />;
    case "pair":
      return <PairRow page={row.page} left={row.left} right={row.right} />;
    case "pending":
      return <Pending path={row.path} offset={row.offset} first={row.first} failed={failed.has(`${row.path}\u0000${row.offset}`)} want={want} retry={retry} split={mode === "split"} />;
    case "note":
      return (
        <div className={s.note}>
          <Text size="sm" tone="quiet">
            {row.text}
          </Text>
        </div>
      );
    case "more":
      return <More left={row.left} more={more} />;
  }
});

/** A file's header: its path, what happened to it, and its line counts; pressed, it folds. Also a chat diff block's. */
export function FileHeader({ f, open, toggle }: { f: PrFile; open: boolean; toggle: (path: string) => void }) {
  const words = statusWords(f);
  return (
    <button type="button" className={s.fileHead} aria-expanded={open} onClick={() => toggle(f.path)}>
      <ChevronDown aria-hidden />
      <span className={s.filePath}>
        <Truncate mono size="sm" expand="none">
          {f.path}
        </Truncate>
      </span>
      {words !== "" ? (
        <span className={s.fileWords}>
          <Truncate size="xs" tone="quiet" expand="none">
            {words}
          </Truncate>
        </span>
      ) : null}
      <span className={s.fileStat}>
        <span className={s.add}>+{stat(f.additions)}</span>
        <span className={s.del}>−{stat(f.deletions)}</span>
      </span>
    </button>
  );
}

/** A hunk's start: "Line 120 · fn main". */
export function HunkRow({ line }: { line: DiffLine }) {
  return (
    <div className={s.hunk}>
      <Truncate size="xs" tone="quiet" expand="none">
        {hunkText(line)}
      </Truncate>
    </div>
  );
}

const mark = (l: DiffLine | null) => (l === null ? "" : l.kind === "add" ? "+" : l.kind === "del" ? "−" : "");
const tone = (l: DiffLine | null) => (l === null ? s.empty : l.kind === "add" ? s.isAdd : l.kind === "del" ? s.isDel : undefined);

function Code({ page, line, side }: { page: Page; line: DiffLine; side: "old" | "new" }) {
  const tokens = usePageTokens(page);
  const sides = tokens === undefined ? undefined : side === "old" ? tokens.old : tokens.new;
  const at = sides == null ? undefined : (side === "old" ? sidesOf(page).oldIndex : sidesOf(page).newIndex).get(line);
  const toks = at === undefined ? undefined : sides?.[at];
  return (
    <>
      {toks === undefined ? line.text : renderTokens(toks)}
      {line.cut === true ? <span className={s.cut}> … cut, open on GitHub for the whole line</span> : null}
    </>
  );
}

/** One line of a unified diff, coloured once its page is highlighted. Also a chat diff block's. */
export function LineRow({ page, line }: { page: Page; line: DiffLine }) {
  return (
    <div className={cx(s.line, s.unified)}>
      <span className={cx(s.num, tone(line))}>{line.old ?? ""}</span>
      <span className={cx(s.num, tone(line))}>{line.new ?? ""}</span>
      <span className={cx(s.mark, tone(line))}>{mark(line)}</span>
      <span className={cx(s.code, tone(line))}>
        <Code page={page} line={line} side={line.kind === "del" ? "old" : "new"} />
      </span>
    </div>
  );
}

function PairRow({ page, left, right }: { page: Page; left: DiffLine | null; right: DiffLine | null }) {
  return (
    <div className={cx(s.line, s.split)}>
      <span className={cx(s.num, tone(left))}>{left?.old ?? ""}</span>
      <span className={cx(s.mark, tone(left))}>{mark(left)}</span>
      <span className={cx(s.code, s.splitLeft, tone(left))}>{left ? <Code page={page} line={left} side="old" /> : null}</span>
      <span className={cx(s.num, tone(right))}>{right?.new ?? ""}</span>
      <span className={cx(s.mark, tone(right))}>{mark(right)}</span>
      <span className={cx(s.code, tone(right))}>{right ? <Code page={page} line={right} side="new" /> : null}</span>
    </div>
  );
}

/** A line still to load: one empty line high, so nothing moves when it lands. Drawing it asks for its page. */
function Pending({ path, offset, first, failed, want, retry, split }: { path: string; offset: number; first: boolean; failed: boolean; want: RowProps["want"]; retry: RowProps["retry"]; split: boolean }) {
  useEffect(() => want(path, offset), [want, path, offset]);
  if (failed && first) {
    return (
      <div className={s.note} role="alert">
        <Text size="sm" tone="quiet">
          Couldn’t load these lines.
        </Text>
        <Button variant="quiet" onClick={() => retry(path, offset)}>
          Retry
        </Button>
      </div>
    );
  }
  return <div className={cx(s.line, split ? s.split : s.unified, s.pending)} aria-hidden />;
}

function More({ left, more }: { left: number; more: () => void }) {
  useEffect(() => more(), [more]);
  return (
    <div className={s.note} aria-busy="true">
      <Text size="sm" tone="quiet">
        {left === 1 ? "Loading 1 more file…" : `Loading ${left} more files…`}
      </Text>
    </div>
  );
}

