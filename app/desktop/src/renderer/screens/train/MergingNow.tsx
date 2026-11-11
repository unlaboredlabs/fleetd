// What merges now, in the Shipping list (prs/PrList): the project's merge train's head, one PR or a batch, at its
// stage, with the checks it waits on. The line behind it and what landed are the list's own rows; this is its one card.
// Read through the data layer and refetched on the hub's change and PR events; nothing polls, and nothing here moves
// the train.
import { useMemo } from "react";
import type { ChangesListInput, PrRow, ProjectRef } from "../../../shared/contracts";
import { useToolQueries, useToolQuery } from "../../src/data/react";
import { StateGlyph, Text, Tooltip, Truncate, useBeatRef, type GlyphState } from "../../ui";
import { when } from "../prs/words";
import { panelRoute, toHash } from "../shell/routes";
import { changesOf, checkLines, lineReads, movingNow, STAGE_WORD, stageLine, type Moving, type TrainPr } from "./model";
import s from "./train.module.css";

/** `reads`' answers as one list; undefined until every read answered. A failed read fails them all. */
const useChanges = (reads: readonly ChangesListInput[]) => {
  const results = useToolQueries("changes_list", reads);
  const answers = results.map((r) => r.data);
  // Each read's answer changes only when it answers anew: one stamp for all of them.
  const stamp = results.map((r) => r.dataUpdatedAt).join();
  const merged = useMemo(
    () => (answers.every((a) => a !== undefined) ? changesOf(answers) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stamp],
  );
  return {
    data: merged,
    isError: results.some((r) => r.isError),
    retry: () => {
      for (const r of results) if (r.isError) void r.refetch();
    },
  };
};

export interface MovingNow {
  /** What merges now, a repo's train each, busiest first; none until the train is read. */
  readonly moving: readonly { readonly repo: string; readonly moving: Moving }[];
  /** The train read: the list's `/train` states follow it. */
  readonly state: "ready" | "loading" | "error";
  readonly retry: () => void;
}

/** What merges now on the project's train, titled from `prs` (the list's own read; by branch without it). */
export const useMoving = (project: ProjectRef, prs: readonly PrRow[] | undefined, enabled = true): MovingNow => {
  const changes = useChanges(enabled ? lineReads(project) : []);
  const moving = useMemo(() => (changes.data === undefined ? [] : movingNow(changes.data, prs)), [changes.data, prs]);
  return { moving, state: changes.data !== undefined ? "ready" : changes.isError ? "error" : "loading", retry: changes.retry };
};

const whenAt = (iso: string, nowMs: number | undefined): string => when(iso, nowMs ?? Date.parse(iso));

const prHref = (project: ProjectRef, pr: Pick<TrainPr, "repo" | "number">): string =>
  toHash(panelRoute(project, { tab: "prs", pr: { repo: pr.repo, number: pr.number } }));

/** A check's state as a glyph (StateGlyph): a running one is the only one that moves. */
const CHECK_GLYPH = { failed: "failed", working: "working", done: "done", idle: "queued" } as const satisfies Record<string, GlyphState>;

/** The card: its stage (what the train does at it in the stage's hover), since when, its PR or batch, its checks. */
export function MergingNow({ moving, repo, project, nowMs }: { moving: Moving; repo?: string | undefined; project: ProjectRef; nowMs: number | undefined }) {
  const one = moving.prs.length === 1 ? moving.prs[0] : undefined;
  // Only a lone PR's own checks are the train's: a batch runs one CI of its own.
  const detail = useToolQuery("pr_get", { repo: one?.repo ?? "", number: one?.number ?? 0 }, { enabled: one !== undefined });
  const checks = one === undefined || detail.data === undefined ? undefined : checkLines(detail.data.checks);
  // The CI band steps on the app's beat.
  const band = useBeatRef<HTMLSpanElement>(moving.stage === "ci");
  return (
    <div className={s.head} data-stage={moving.stage} data-moving="">
      {moving.stage === "ci" ? <span ref={band} className={s.progress} aria-hidden /> : null}
      <div className={s.headTop}>
        <Tooltip content={stageLine(moving)} side="bottom">
          <span className={s.stage} tabIndex={0}>
            <StateGlyph state="working" size="sm" />
            {STAGE_WORD[moving.stage]}
          </span>
        </Tooltip>
        {moving.prs.length > 1 ? (
          <Text size="xs" tone="quiet">
            {`Batch of ${moving.prs.length}`}
          </Text>
        ) : null}
        {repo === undefined ? null : (
          <Text size="xs" tone="quiet">
            {repo.slice(repo.lastIndexOf("/") + 1)}
          </Text>
        )}
        <span className={s.since}>
          <Text size="xs" tone="faint" tabular>
            {`since ${whenAt(moving.since, nowMs)}`}
          </Text>
        </span>
      </div>
      <div className={moving.prs.length > 1 ? s.batch : undefined}>
        {moving.prs.map((pr) => (
          <Tooltip key={pr.changeId} content={`${pr.repo.slice(pr.repo.lastIndexOf("/") + 1)}#${pr.number}`} side="left">
            <a className={s.row} href={prHref(project, pr)} data-pr={pr.number}>
              <Truncate lines={2} expand="none">
                {pr.title}
              </Truncate>
            </a>
          </Tooltip>
        ))}
      </div>
      {checks !== undefined && checks.shown.length > 0 ? (
        <ul className={s.checks} aria-label="Checks">
          {checks.shown.map((c) => (
            <li key={c.name} className={s.check}>
              <StateGlyph state={CHECK_GLYPH[c.tone]} size="sm" settled />
              <span className={s.checkName}>
                <Truncate size="xs" expand="popover">
                  {c.name}
                </Truncate>
              </span>
              <Text size="xs" tone={c.tone === "failed" ? "danger" : "faint"}>
                {c.word}
              </Text>
            </li>
          ))}
          {checks.more > 0 ? (
            <li className={s.check}>
              <Text size="xs" tone="faint">{`${checks.more} more`}</Text>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
