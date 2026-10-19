import { ChevronDown } from "lucide-react";
import { memo, useMemo, useState, type ReactNode } from "react";
import { cx } from "../lib/cx";
import { Button } from "../primitives/Button";
import { Code, renderTokens, useTokens } from "../markdown/Code";
import { langForPath, type Tokens } from "../markdown/highlighter";
import { Text } from "../text/Text";
import { Truncate } from "../text/Truncate";
import { parsePatch, toSplitRows, type DiffFile, type DiffLine } from "./parsePatch";
import s from "./DiffView.module.css";

export type DiffMode = "unified" | "split";

export interface DiffViewProps {
  /** A unified diff (git diff output). Anything else is shown as raw text with a note. */
  patch: string;
  mode?: DiffMode;
  onModeChange?: (mode: DiffMode) => void;
  /** Wrap long lines (default) or scroll each file sideways. */
  wrap?: boolean;
  /** Files with more changed lines than this start folded. */
  foldOver?: number;
  /** Hide the toolbar (totals, unified/split, wrap). */
  bare?: boolean;
  className?: string | undefined;
}

const CHANGE_WORD = { added: "added", deleted: "deleted", renamed: "renamed", modified: "" } as const;

/** A diff, one block per file, unified or side by side, with syntax colours from the file's extension. */
export const DiffView = memo(function DiffView(props: DiffViewProps) {
  const parsed = useMemo(() => parsePatch(props.patch), [props.patch]);
  const [ownMode, setOwnMode] = useState<DiffMode>("unified");
  const mode = props.mode ?? ownMode;
  const setMode = (m: DiffMode) => {
    setOwnMode(m);
    props.onModeChange?.(m);
  };
  const [wrap, setWrap] = useState(props.wrap ?? true);

  if (!parsed) return <Text tone="quiet">No changes.</Text>;
  if (parsed.kind === "raw") {
    return (
      <div className={cx(s.root, props.className)}>
        <Text size="xs" className={s.rawReason}>
          {parsed.reason}
        </Text>
        <Code code={parsed.text} bare />
      </div>
    );
  }

  const additions = parsed.files.reduce((n, f) => n + f.additions, 0);
  const deletions = parsed.files.reduce((n, f) => n + f.deletions, 0);
  const files = parsed.files.length;

  return (
    <div className={cx(s.root, props.className)}>
      {props.bare ? null : (
        <div className={s.toolbar}>
          <span className={s.stats}>
            {files} {files === 1 ? "file" : "files"} · <span className={s.add}>+{additions}</span>{" "}
            <span className={s.del}>−{deletions}</span>
          </span>
          <Button variant="quiet" aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
            {wrap ? "Wrapped" : "Not wrapped"}
          </Button>
          <div className={s.segmented} role="group" aria-label="Diff layout">
            <button type="button" aria-pressed={mode === "unified"} onClick={() => setMode("unified")}>
              Unified
            </button>
            <button type="button" aria-pressed={mode === "split"} onClick={() => setMode("split")}>
              Split
            </button>
          </div>
        </div>
      )}
      {parsed.files.map((f, i) => (
        <FileBlock key={`${f.oldPath ?? ""}\u0000${f.path}\u0000${f.change}\u0000${String(i)}`} file={f} mode={mode} wrap={wrap} foldOver={props.foldOver ?? 800} />
      ))}
    </div>
  );
});

/** Each side of a file as one text, so the highlighter sees whole runs of code instead of single lines. */
function sideTexts(file: DiffFile) {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const oldIndex = new Map<DiffLine, number>();
  const newIndex = new Map<DiffLine, number>();
  for (const h of file.hunks)
    for (const l of h.lines) {
      if (l.kind !== "add") {
        oldIndex.set(l, oldLines.length);
        oldLines.push(l.text);
      }
      if (l.kind !== "del") {
        newIndex.set(l, newLines.length);
        newLines.push(l.text);
      }
    }
  return { oldText: oldLines.join("\n"), newText: newLines.join("\n"), oldIndex, newIndex };
}

function FileBlock({ file, mode, wrap, foldOver }: { file: DiffFile; mode: DiffMode; wrap: boolean; foldOver: number }) {
  const [open, setOpen] = useState(file.additions + file.deletions <= foldOver && file.change !== "deleted");
  const title = file.change === "renamed" && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <section className={s.file}>
      <button type="button" className={s.fileHead} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <ChevronDown />
        <span className={s.filePath}>
          <Truncate mono size="sm" expand="none">
            {title}
          </Truncate>
        </span>
        {CHANGE_WORD[file.change] ? <span className={s.change}>{CHANGE_WORD[file.change]}</span> : null}
        <span className={s.fileStats}>
          <span className={s.add}>+{file.additions}</span>
          <span className={s.del}>−{file.deletions}</span>
        </span>
      </button>
      {open ? <FileBody file={file} mode={mode} wrap={wrap} /> : null}
    </section>
  );
}

function FileBody({ file, mode, wrap }: { file: DiffFile; mode: DiffMode; wrap: boolean }) {
  const sides = useMemo(() => sideTexts(file), [file]);
  const lang = langForPath(file.path);
  const oldTokens = useTokens(sides.oldText, lang);
  const newTokens = useTokens(sides.newText, lang);

  if (file.binary) return <div className={s.note}>Binary file, not shown.</div>;
  if (file.hunks.length === 0) return <div className={s.note}>{file.change === "renamed" ? "Renamed without changes." : "No changed lines."}</div>;

  const content = (line: DiffLine, side: "old" | "new"): ReactNode => {
    const tokens: Tokens | undefined = side === "old" ? oldTokens : newTokens;
    const idx = (side === "old" ? sides.oldIndex : sides.newIndex).get(line);
    const toks = idx === undefined ? undefined : tokens?.[idx];
    return (
      <>
        {toks ? renderTokens(toks) : line.text}
        {line.noNewline ? <span className={s.eof}> ⏎ no newline at end</span> : null}
      </>
    );
  };
  const tone = (l: DiffLine | null) => (l === null ? s.isEmpty : l.kind === "add" ? s.isAdd : l.kind === "del" ? s.isDel : undefined);
  const mark = (l: DiffLine | null) => (l === null ? "" : l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ");

  return (
    <div className={s.body} data-text="code">
      <div className={cx(s.grid, mode === "split" ? s.split : s.unified, !wrap && s.nowrap)} role="table" aria-label={`Changes in ${file.path}`}>
        {file.hunks.map((h, hi) => (
          <HunkRows key={hi} gapBefore={h.collapsedBefore} section={h.section}>
            {mode === "unified"
              ? h.lines.map((l, li) => (
                  <div key={li} className={s.row} role="row">
                    <span className={cx(s.num, tone(l))}>{l.oldNo ?? ""}</span>
                    <span className={cx(s.num, tone(l))}>{l.newNo ?? ""}</span>
                    <span className={cx(s.mark, tone(l))}>{mark(l)}</span>
                    <span className={cx(s.text, tone(l))}>{content(l, l.kind === "del" ? "old" : "new")}</span>
                  </div>
                ))
              : toSplitRows(h.lines).map((r, ri) => (
                  <div key={ri} className={s.row} role="row">
                    <span className={cx(s.num, tone(r.left))}>{r.left?.oldNo ?? ""}</span>
                    <span className={cx(s.mark, tone(r.left))}>{mark(r.left)}</span>
                    <span className={cx(s.text, s.splitLeft, tone(r.left))}>{r.left ? content(r.left, "old") : ""}</span>
                    <span className={cx(s.num, tone(r.right))}>{r.right?.newNo ?? ""}</span>
                    <span className={cx(s.mark, tone(r.right))}>{mark(r.right)}</span>
                    <span className={cx(s.text, tone(r.right))}>{r.right ? content(r.right, "new") : ""}</span>
                  </div>
                ))}
          </HunkRows>
        ))}
      </div>
    </div>
  );
}

function HunkRows({ gapBefore, section, children }: { gapBefore: number; section: string; children: ReactNode }) {
  const label = gapBefore > 0 ? `${String(gapBefore)} unchanged ${gapBefore === 1 ? "line" : "lines"}` : "";
  const text = [label, section].filter(Boolean).join(" · ");
  return (
    <>
      {text ? (
        <div className={s.gap} role="row">
          {text}
        </div>
      ) : null}
      {children}
    </>
  );
}
