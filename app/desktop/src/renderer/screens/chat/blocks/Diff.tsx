// A diff block: each file under the PR view's own header, its lines as the PR view draws them (numbers, marks,
// syntax colours). Long changes show their first lines, with the rest one press away; a PR's changes are a card that
// opens the PR beside the chat.
import { useMemo, useState } from "react";
import type { DiffBlock, DiffFile } from "../../../../shared/contracts";
import { Button, Text } from "../../../ui";
import { FileHeader, HunkRow, LineRow } from "../../prs/DiffPane";
import { fileOf, hunkLines } from "./diffBlock";
import { PrCard } from "./PrCard";
import b from "./blocks.module.css";

/** Lines a file shows before "Show all". */
const FIRST = 24;

function FileDiff({ file }: { file: DiffFile }) {
  const lines = useMemo(() => hunkLines(file.hunks), [file.hunks]);
  const page = useMemo(() => ({ path: file.path, offset: 0, lines }), [file.path, lines]);
  const f = useMemo(() => fileOf(file, lines), [file, lines]);
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, FIRST);
  return (
    <div className={b.file}>
      <FileHeader f={f} open={open} toggle={() => setOpen((o) => !o)} />
      {open ? (
        <>
          {shown.map((l, i) => (l.kind === "hunk" ? <HunkRow key={i} line={l} /> : <LineRow key={i} page={page} line={l} />))}
          {shown.length < lines.length ? (
            <div className={b.more}>
              <Button variant="ghost" onClick={() => setAll(true)}>
                {`Show all ${String(lines.length)} lines`}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function Diff({ diff }: { diff: DiffBlock }) {
  if (diff.pr !== undefined) return <PrCard pr={diff.pr} changes />;
  return (
    <div className={b.card}>
      {diff.title !== undefined ? (
        <div className={b.head}>
          <Text size="sm" strong>
            {diff.title}
          </Text>
        </div>
      ) : null}
      <div className={b.files}>
        {(diff.files ?? []).map((f) => (
          <FileDiff key={f.path} file={f} />
        ))}
      </div>
    </div>
  );
}
