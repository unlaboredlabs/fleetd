// The panel's Train: the project's merge train at a glance. What merges now and at which stage (with the checks it
// waits on), the queue in train order with what holds each one, and the merges and refusals of late, a batch shown as
// one group. Each PR opens in the PRs tab. Read through the data layer and refetched on the hub's change and PR
// events; nothing polls, and nothing here moves the train.
import { useMemo, type ReactNode } from "react";
import type { ChangesListInput, ProjectRef } from "../../../shared/contracts";
import { useData, useToolQueries, useToolQuery } from "../../src/data/react";
import { Button, cx, Dot, EmptyState, StateGlyph, Text, Truncate, useArrivals, useArrived, useBeatRef, useLeavers, type GlyphState } from "../../ui";
import { when } from "../prs/words";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import { SignOffRow, useSignOffWaiting } from "../tryit/SignOff";
import { askTab, openOrStart, PREVIEW_PR } from "../tryit/preview";
import { changesOf, checkLines, lineReads, onTrain, trainReads, STAGE_WORD, stageLine, trainViews, WAITING_WORD, type Moving, type QueueRow, type Recent, type TrainPr, type TrainView } from "./model";
import s from "./train.module.css";

const useMissing = (project: ProjectRef): boolean => {
  const title = useData((st) => st.projects[`${project.machineId}/${project.projectId}`]?.title);
  const fresh = useData((st) => st.fresh);
  // A link to a project the hub doesn't have (removed, or another hub's) says so instead of asking for its train.
  return fresh && title === undefined;
};

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

/** PRs on the project's train (merging now or in line), for the tab's count; undefined until the hub answers. */
export const useTrainCount = (project: ProjectKey): number | undefined => {
  const missing = useMissing(project);
  const changes = useChanges(missing ? [] : lineReads(project)).data?.changes;
  return useMemo(() => (changes === undefined ? undefined : onTrain(trainViews(changes, undefined))), [changes]);
};

/** The tab's badge: the PRs on the train, none while it's empty or unread. */
export function TrainCount({ project }: { project: ProjectKey }) {
  const n = useTrainCount(project) ?? 0;
  return n > 0 ? String(n) : null;
}

const whenAt = (iso: string, nowMs: number | undefined): string => when(iso, nowMs ?? Date.parse(iso));

const prHref = (project: ProjectRef, pr: Pick<TrainPr, "repo" | "number">): string =>
  toHash(panelRoute(project, { tab: "prs", pr: { repo: pr.repo, number: pr.number } }));

export function TrainPane({ project }: { project: ProjectKey }) {
  const fresh = useData((st) => st.fresh);
  const missing = useMissing(project);
  const changes = useChanges(missing ? [] : trainReads(project));
  // The PRs tab's own read: titles and checks. Without it the rows read by branch.
  const prs = useToolQuery("pr_list", { projectRef: project }, { enabled: !missing });
  const views = useMemo(() => (changes.data === undefined ? undefined : trainViews(changes.data.changes, prs.data?.prs)), [changes.data, prs.data]);
  // The hub's clock, as the PRs tab reads it; until the PR list answers, times read as the hour they happened at.
  const nowMs = prs.data === undefined ? undefined : Date.parse(prs.data.at);

  if (missing) {
    return (
      <div className={s.screen} data-screen="train.missing">
        <EmptyState title="This project isn’t on the hub">It may have been removed.</EmptyState>
      </div>
    );
  }
  const state = views !== undefined ? (views.length === 0 ? "train.empty" : "train") : changes.isError ? "train.error" : "train.loading";
  return (
    <div className={s.screen} data-screen={state}>
      {!fresh ? (
        <span className={s.liveness} role="status">
          <Dot color="var(--warning)" />
          <Text size="xs">Not live: reconnecting</Text>
        </span>
      ) : null}
      {views !== undefined ? (
        views.length === 0 ? (
          <div className={s.empty}>
            <EmptyState title="Nothing on the train">PRs the agents open line up here, are reviewed, and merge one after another.</EmptyState>
          </div>
        ) : (
          <div className={s.scroll}>
            {changes.data?.cut === true ? (
              <Text as="p" size="xs" tone="quiet" className={s.quietLine}>
                More PRs wait than the hub sends at once; the rest show as these move on.
              </Text>
            ) : null}
            {views.map((v) => (
              <Train key={v.repo} view={v} project={project} nowMs={nowMs} named={views.length > 1} />
            ))}
          </div>
        )
      ) : !fresh ? (
        // Nothing held and no hub to ask: "Loading" would never finish.
        <div className={s.note}>
          <Text tone="quiet">The train shows once you’re connected.</Text>
        </div>
      ) : changes.isError ? (
        <div className={s.note} role="alert">
          <Text tone="quiet">Couldn’t read the merge train.</Text>
          <Button onClick={changes.retry}>Retry</Button>
        </div>
      ) : (
        <div className={s.skeleton} aria-busy="true" aria-label="Loading the merge train">
          <span />
          <span />
          <span />
        </div>
      )}
    </div>
  );
}

const queueKey = (q: QueueRow): string => q.pr.changeId;

function Train({ view, project, nowMs, named }: { view: TrainView; project: ProjectRef; nowMs: number | undefined; named: boolean }) {
  // A merge that lands while this train is open wipes its check in; those it opened with are still.
  const merges = `train:${project.machineId}/${project.projectId}:${view.repo}`;
  const queue = useLeavers(view.queue, queueKey, merges);
  // The design preview's sign-off (screens/tryit): a PR the person asked to try waits on them here.
  const signOff = useSignOffWaiting(project) && view.repo === PREVIEW_PR.repo;
  useArrivals(merges, view.recent.map((r) => (r.kind === "merged" ? r.prs.map((p) => p.changeId).join() : r.pr.changeId)));
  return (
    <div className={s.train}>
      {named ? (
        <Text as="h3" size="sm" strong className={s.repo}>
          {view.repo}
        </Text>
      ) : null}
      <Section label="Merging now">
        {view.moving === undefined ? (
          <Text size="sm" tone="quiet" className={s.quietLine}>
            Nothing is merging right now.
          </Text>
        ) : (
          <Head moving={view.moving} project={project} nowMs={nowMs} />
        )}
      </Section>
      {signOff ? (
        <Section label="Waiting on you" count={1}>
          <SignOffRow
            onTry={() => {
              openOrStart();
              askTab();
              window.location.hash = toHash(panelRoute(project, { tab: "prs", pr: { repo: PREVIEW_PR.repo, number: PREVIEW_PR.number } }));
            }}
          />
        </Section>
      ) : null}
      <Section label="In line" count={view.queue.length}>
        {view.queue.length === 0 ? (
          <Text size="sm" tone="quiet" className={s.quietLine}>
            No PRs waiting.
          </Text>
        ) : (
          <ol className={s.list}>
            {queue?.map(({ item: q, leaving }) => (
              // A PR that left the line (on to merging, or out) fades where it stood (ui/lib/leaving), then goes.
              <li key={q.pr.changeId} {...(leaving ? { "data-leaving": "", inert: true, "aria-hidden": true } : {})}>
                <QueueItem row={q} project={project} />
              </li>
            ))}
          </ol>
        )}
      </Section>
      {view.recent.length > 0 ? (
        <Section label="Recent">
          <ul className={cx(s.list, s.recent)}>
            {view.recent.map((r) => (
              <li key={r.kind === "merged" ? r.prs.map((p) => p.changeId).join() : r.pr.changeId}>
                <RecentItem item={r} project={project} nowMs={nowMs} list={merges} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function Section({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  return (
    <section className={s.section} aria-label={label}>
      <div className={s.group}>
        <Text size="xs" tone="quiet" strong>
          {label}
        </Text>
        {count !== undefined && count > 0 ? (
          <Text size="xs" tone="quiet" tabular>
            {count}
          </Text>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** A PR's title and number, as a link to it in the PRs tab. */
function PrLink({ pr, project, children }: { pr: TrainPr; project: ProjectRef; children?: ReactNode }) {
  return (
    <a className={s.row} href={prHref(project, pr)} data-pr={pr.number}>
      <span className={s.rowTop}>
        <span className={s.rowTitle}>
          <Truncate lines={2} expand="none">
            {pr.title}
          </Truncate>
        </span>
        <Text size="xs" tone="faint" tabular>
          #{pr.number}
        </Text>
      </span>
      {children}
    </a>
  );
}

function Head({ moving, project, nowMs }: { moving: Moving; project: ProjectRef; nowMs: number | undefined }) {
  const one = moving.prs.length === 1 ? moving.prs[0] : undefined;
  // Only a lone PR's own checks are the train's: a batch runs one CI of its own.
  const detail = useToolQuery("pr_get", { repo: one?.repo ?? "", number: one?.number ?? 0 }, { enabled: one !== undefined });
  const checks = one === undefined || detail.data === undefined ? undefined : checkLines(detail.data.checks);
  // The CI band steps on the app's beat.
  const band = useBeatRef<HTMLSpanElement>(moving.stage === "ci");
  return (
    <div className={s.head} data-stage={moving.stage}>
      {moving.stage === "ci" ? <span ref={band} className={s.progress} aria-hidden /> : null}
      <div className={s.headTop}>
        <span className={s.stage}>
          <StateGlyph state="working" size="sm" />
          {STAGE_WORD[moving.stage]}
        </span>
        {moving.prs.length > 1 ? (
          <Text size="xs" tone="quiet">
            {`Batch of ${moving.prs.length}`}
          </Text>
        ) : null}
        <span className={s.since}>
          <Text size="xs" tone="faint" tabular>
            {`since ${whenAt(moving.since, nowMs)}`}
          </Text>
        </span>
      </div>
      <Text size="xs" tone="quiet" className={s.stageLine}>
        {stageLine(moving)}
      </Text>
      <div className={moving.prs.length > 1 ? s.batch : undefined}>
        {moving.prs.map((pr) => (
          <PrLink key={pr.changeId} pr={pr} project={project} />
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

/** A check's state as a glyph (StateGlyph): a running one is the only one that moves. */
const CHECK_GLYPH = { failed: "failed", working: "working", done: "done", idle: "queued" } as const satisfies Record<string, GlyphState>;

function QueueItem({ row, project }: { row: QueueRow; project: ProjectRef }) {
  const word = WAITING_WORD[row.state];
  return (
    <div className={s.queued}>
      <span className={s.place}>
        <Text size="xs" tone="faint" tabular>
          {row.place ?? "–"}
        </Text>
      </span>
      <PrLink pr={row.pr} project={project}>
        <span className={s.rowMeta}>
          <span className={s.word} data-tone={row.sentBack === true ? "failed" : word.tone}>
            {row.sentBack === true ? "sent back" : word.word}
          </span>
        </span>
        {row.why !== undefined ? (
          <span className={s.why}>
            <Truncate size="xs" tone="quiet" lines={2} expand="none">
              {row.why}
            </Truncate>
          </span>
        ) : null}
        {row.detail !== undefined ? (
          <span className={s.why}>
            <Truncate as="code" size="xs" tone="quiet" mono lines={2} expand="none">
              {row.detail}
            </Truncate>
          </span>
        ) : null}
      </PrLink>
    </div>
  );
}

/** "merged" behind a check that wipes in when the merge happens while you look at this project's train; else still. */
function Merged({ id, list, words = "merged" }: { id: string; list: string; words?: string }) {
  const fresh = useArrived(list, id);
  return (
    <span className={s.merged}>
      <StateGlyph state="done" size="sm" settled={!fresh} />
      <Text size="xs" tone="quiet">
        {words}
      </Text>
    </span>
  );
}

/** `list`: the merges' arrival list (ui/lib/arrival), so one that lands while you look wipes its mark in. */
function RecentItem({ item, project, nowMs, list }: { item: Recent; project: ProjectRef; nowMs: number | undefined; list: string }) {
  const at = (
    <Text size="xs" tone="faint" tabular>
      {whenAt(item.at, nowMs)}
    </Text>
  );
  if (item.kind === "refused") {
    return (
      <PrLink pr={item.pr} project={project}>
        <span className={s.rowMeta}>
          <span className={s.word} data-tone="failed">
            refused
          </span>
          {at}
        </span>
        {item.why !== undefined ? (
          <span className={s.why}>
            <Truncate size="xs" tone="quiet" lines={2} expand="none">
              {item.why}
            </Truncate>
          </span>
        ) : null}
      </PrLink>
    );
  }
  const [only] = item.prs;
  if (item.prs.length === 1 && only !== undefined) {
    return (
      <PrLink pr={only} project={project}>
        <span className={s.rowMeta}>
          <Merged id={only.changeId} list={list} />
          {at}
        </span>
      </PrLink>
    );
  }
  return (
    <div className={s.landedBatch} role="group" aria-label={`Batch of ${item.prs.length}, merged together`}>
      <span className={s.batchMeta}>
        <Merged id={item.prs.map((p) => p.changeId).join()} list={list} words={`merged as a batch of ${item.prs.length}`} />
        {at}
      </span>
      <div className={s.batch}>
        {item.prs.map((pr) => (
          <PrLink key={pr.changeId} pr={pr} project={project} />
        ))}
      </div>
    </div>
  );
}
