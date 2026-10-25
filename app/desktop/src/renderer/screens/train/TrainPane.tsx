// The panel's Train: the project's merge train at a glance. What merges now and at which stage (with the checks it
// waits on), the queue in train order with what holds each one, and the merges and refusals of late, a batch shown as
// one group. Each PR opens in the PRs tab. Read through the data layer and refetched on the hub's change and PR
// events; nothing polls, and nothing here moves the train.
import { useMemo, type ReactNode } from "react";
import type { ProjectRef } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { Button, Dot, EmptyState, StatusChip, Text, Truncate } from "../../ui";
import { when } from "../prs/words";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import { checkLines, onTrain, STAGE_WORD, stageLine, trainViews, WAITING_WORD, type Moving, type QueueRow, type Recent, type TrainPr, type TrainView } from "./model";
import s from "./train.module.css";

/** The project's changes, newest first: its train's head, queue and recent landings are among the last hundred. */
const changesInput = (project: ProjectRef) => ({ projectRef: project, limit: 100 });

const useMissing = (project: ProjectRef): boolean => {
  const title = useData((st) => st.projects[`${project.machineId}/${project.projectId}`]?.title);
  const fresh = useData((st) => st.fresh);
  // A link to a project the hub doesn't have (removed, or another hub's) says so instead of asking for its train.
  return fresh && title === undefined;
};

/** PRs on the project's train (merging now or in line), for the tab's count; undefined until the hub answers. */
export const useTrainCount = (project: ProjectKey): number | undefined => {
  const missing = useMissing(project);
  const changes = useToolQuery("changes_list", changesInput(project), { enabled: !missing });
  return useMemo(() => (changes.data === undefined ? undefined : onTrain(trainViews(changes.data.changes, undefined))), [changes.data]);
};

const whenAt = (iso: string, nowMs: number | undefined): string => when(iso, nowMs ?? Date.parse(iso));

const prHref = (project: ProjectRef, pr: Pick<TrainPr, "repo" | "number">): string =>
  toHash(panelRoute(project, { tab: "prs", pr: { repo: pr.repo, number: pr.number } }));

export function TrainPane({ project }: { project: ProjectKey }) {
  const fresh = useData((st) => st.fresh);
  const missing = useMissing(project);
  const changes = useToolQuery("changes_list", changesInput(project), { enabled: !missing });
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
          <Button onClick={() => void changes.refetch()}>Retry</Button>
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

function Train({ view, project, nowMs, named }: { view: TrainView; project: ProjectRef; nowMs: number | undefined; named: boolean }) {
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
      <Section label="In line" count={view.queue.length}>
        {view.queue.length === 0 ? (
          <Text size="sm" tone="quiet" className={s.quietLine}>
            No PRs waiting.
          </Text>
        ) : (
          <ol className={s.list}>
            {view.queue.map((q) => (
              <li key={q.pr.changeId}>
                <QueueItem row={q} project={project} />
              </li>
            ))}
          </ol>
        )}
      </Section>
      {view.recent.length > 0 ? (
        <Section label="Recent">
          <ul className={s.list}>
            {view.recent.map((r) => (
              <li key={r.kind === "merged" ? r.prs.map((p) => p.changeId).join() : r.pr.changeId}>
                <RecentItem item={r} project={project} nowMs={nowMs} />
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
  return (
    <div className={s.head} data-stage={moving.stage}>
      <div className={s.headTop}>
        <StatusChip tone="working">{STAGE_WORD[moving.stage]}</StatusChip>
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
              <Dot color={CHECK_DOT[c.tone]} />
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

const CHECK_DOT = { failed: "var(--danger)", working: "var(--text)", done: "var(--success)", idle: "var(--faint)" } as const;

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
          <StatusChip tone={word.tone} inRow>
            {row.sentBack === true ? "sent back" : word.word}
          </StatusChip>
        </span>
        {row.why !== undefined ? (
          <span className={s.why}>
            <Truncate size="xs" tone="quiet" lines={2} expand="none">
              {row.why}
            </Truncate>
          </span>
        ) : null}
      </PrLink>
    </div>
  );
}

function RecentItem({ item, project, nowMs }: { item: Recent; project: ProjectRef; nowMs: number | undefined }) {
  const at = (
    <Text size="xs" tone="faint" tabular>
      {whenAt(item.at, nowMs)}
    </Text>
  );
  if (item.kind === "refused") {
    return (
      <PrLink pr={item.pr} project={project}>
        <span className={s.rowMeta}>
          <StatusChip tone="failed" inRow>
            refused
          </StatusChip>
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
          <StatusChip tone="done" inRow>
            merged
          </StatusChip>
          {at}
        </span>
      </PrLink>
    );
  }
  return (
    <div className={s.landedBatch} role="group" aria-label={`Batch of ${item.prs.length}, merged together`}>
      <span className={s.batchMeta}>
        <StatusChip tone="done">{`merged as a batch of ${item.prs.length}`}</StatusChip>
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
