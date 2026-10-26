// Status (⌘.): one row per project under one line of column names. A state word, its work counted by group (waiting
// on you, in review, working, landing, idle, done), agents running, last merged; under it, the items of each group,
// each opening its agent or PR in the project's panel. A row opens the project's chat; its PRs link opens the
// project's PR list, and its 7-day count opens the project's Factory numbers. A row its machine's usage pause blocks
// says so under it, with Resume. Nothing is scored or estimated.
// It cannot be stale: the rows come from the data layer (status_get, refetched on events), which drops every
// answer on a reconnect, so the view is a skeleton until this connection has answered; a row whose source went
// quiet says so.

import { useMemo } from "react";
import type { ProjectStatusRow } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { useNow } from "../live/clock";
import { selectSkew } from "../live/strip";
import { selectProjectList } from "../../src/data/selectors";
import { Button, cx, Dot, FrameTitle, Text, Tooltip, Truncate } from "../../ui";
import { toHash } from "../shell/routes";
import { countsLine, GROUP_WORDS, groupsOf, itemHref, itemRefs, orderRows, STATE_WORDS, type StateWord } from "./rows";
import { fullWhen, staleWords, weekLine, when } from "./view";
import { ResumeButton } from "./Resume";
import s from "./status.module.css";

const ALL = {} as const;
const MINUTE = 60_000;

/** A project's chat (F1's route table). */
export const projectHref = (ref: ProjectStatusRow["projectRef"]): string =>
  `#/project/${encodeURIComponent(ref.machineId)}/${encodeURIComponent(ref.projectId)}`;

/** A project's PR list: its chat with the panel on its PRs (shell/routes.ts). */
export const prsHref = (ref: ProjectStatusRow["projectRef"]): string => `${projectHref(ref)}/prs`;

/** A project's Factory numbers: what it merged and how (`#/factory?project=<machine>/<project>`). */
export const factoryHref = (ref: ProjectStatusRow["projectRef"]): string =>
  toHash({ id: "factory", project: { machineId: ref.machineId, projectId: ref.projectId } });

/** One phrase wherever no group has work. */
const NO_WORK = "no work yet";

export function StatusScreen() {
  const fresh = useData((st) => st.fresh);
  const query = useToolQuery("status_get", ALL);
  const projects = useData(selectProjectList);
  const rows = useMemo(() => (query.data === undefined ? undefined : orderRows(query.data.rows ?? [], projects)), [query.data, projects]);
  // The hub's clock for "today 14:02" and "out of date for 11m". Not the rows' as-of: an idle fleet sends no events,
  // so nothing refetches them, and a day word or an age read from them would stop. Minutes are the finest unit shown.
  const now = useNow(true, MINUTE) + useData(selectSkew);

  return (
    <div className={cx(s.screen)} data-screen="status.fleet" data-phase={rows === undefined ? "skeleton" : "live"}>
      <FrameTitle title="Status">
        {!fresh ? (
          <span className={cx(s.liveness)} role="status">
            <Dot color="var(--warning)" />
            <Text size="xs">Reconnecting…</Text>
          </span>
        ) : query.isError ? (
          <span className={cx(s.liveness)} role="alert">
            <Dot color="var(--warning)" />
            <Text size="xs">Couldn't refresh Status</Text>
            <Button variant="quiet" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </span>
        ) : null}
      </FrameTitle>
      <div className={cx(s.body)}>
        {rows === undefined ? (
          <Skeleton />
        ) : rows.length === 0 ? (
          <Text tone="quiet">No projects yet.</Text>
        ) : (
          <ul className={cx(s.rows)} aria-label="Projects">
            {/* The column names, once; each row's link reads its cells as a sentence instead. */}
            <li className={cx(s.columns)} aria-hidden>
              {["Project", "State", "Work", "Agents", "Last merged"].map((h) => (
                <Text key={h} size="xs" tone="quiet" className={cx(h === "Agents" && s.agents)}>
                  {h}
                </Text>
              ))}
            </li>
            {rows.map(({ row, word }) => (
              <Row key={`${row.projectRef.machineId}/${row.projectRef.projectId}`} row={row} state={word} now={now} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const TONE = { waiting_on_you: "warning", blocked: "danger", working: "default", idle: "quiet" } as const;

function Row({ row, state, now }: { row: ProjectStatusRow; state: StateWord; now: number }) {
  const counts = countsLine(row);
  const groups = groupsOf(row).filter((g) => g.items.length > 0);
  const merged = row.lastMerged;
  const week = weekLine(row.merged7d, row.throughFleetdPct7d);
  const mergedAt = merged === undefined ? "" : when(merged.at, now);
  // The pause in its own words: the blocked reason may be the machine's (degraded) instead.
  const pausedWhy = row.usagePausedReason ?? row.blockedReason;
  const label = [
    `${row.title}: ${STATE_WORDS[state]}`,
    ...(row.stale ? [staleWords(row.stale, now)] : []),
    counts === "" ? NO_WORK : counts,
    row.agentsRunning === 1 ? "1 agent running" : `${row.agentsRunning} agents running`,
    merged === undefined ? "nothing merged yet" : `last merged ${mergedAt}`,
  ].join(", ");
  const word = (
    <Text size="sm" strong={state !== "idle"} tone={TONE[state]}>
      {STATE_WORDS[state]}
    </Text>
  );
  return (
    <li className={cx(s.item)}>
      <a className={cx(s.row)} href={projectHref(row.projectRef)} aria-label={label}>
        <span className={cx(s.title)}>
          <Truncate expand="none" strong>
            {row.title}
          </Truncate>
          {row.stale ? (
            <Tooltip content={staleWords(row.stale, now)}>
              <span className={cx(s.stale)} tabIndex={0}>
                <Text size="xs" strong tone="warning">
                  out of date
                </Text>
              </span>
            </Tooltip>
          ) : null}
        </span>
        {row.blockedReason !== undefined && state === "blocked" ? (
          <Tooltip content={row.blockedReason}>
            <span className={cx(s.word)} tabIndex={0}>
              {word}
            </span>
          </Tooltip>
        ) : (
          <span className={cx(s.word)}>{word}</span>
        )}
        <span className={cx(s.work)}>
          <Truncate expand="none" size="xs" tone={counts === "" ? "quiet" : "default"} tabular>
            {counts === "" ? NO_WORK : counts}
          </Truncate>
        </span>
        <Text size="sm" tone={row.agentsRunning > 0 ? "default" : "quiet"} tabular className={cx(s.agents)}>
          {row.agentsRunning > 0 ? String(row.agentsRunning) : "–"}
        </Text>
        {merged !== undefined ? (
          <Tooltip content={`${merged.prNumber === undefined ? merged.title : `#${merged.prNumber}: ${merged.title}`}, ${fullWhen(merged.at)}`}>
            <span className={cx(s.merged)} tabIndex={0}>
              <Text size="xs" tone="quiet" tabular>
                {mergedAt}
              </Text>
            </span>
          </Tooltip>
        ) : (
          <Text size="xs" tone="quiet" className={cx(s.merged)}>
            –
          </Text>
        )}
      </a>
      {week === undefined ? (
        <span aria-hidden />
      ) : (
        <Tooltip content={week}>
          <a className={cx(s.week)} href={factoryHref(row.projectRef)} aria-label={`${row.title}: ${week}, in Factory`}>
            <Text size="xs" tone="quiet" tabular>
              {`${row.merged7d ?? 0} in 7 days`}
            </Text>
          </a>
        </Tooltip>
      )}
      <a className={cx(s.prs)} href={prsHref(row.projectRef)} aria-label={`${row.title}: pull requests`}>
        <Text size="xs" tone="quiet">
          PRs
        </Text>
      </a>
      {row.usagePausedOn === undefined ? null : (
        <div className={cx(s.paused)} data-paused={row.usagePausedOn}>
          <Text size="xs" tone="quiet">
            <Text size="xs" strong tone="warning">
              Usage paused:
            </Text>
            {pausedWhy === undefined ? null : ` ${pausedWhy}`}
          </Text>
          <ResumeButton machineId={row.usagePausedOn} />
        </div>
      )}
      {groups.length === 0 ? null : (
        <ul className={cx(s.groups)} aria-label={`${row.title}: work`}>
          {groups.map((g) => (
            <li key={g.group} className={cx(s.group)}>
              <Text size="xs" strong tone={g.group === "waiting_on_you" ? "warning" : "quiet"}>
                {GROUP_WORDS[g.group]}
              </Text>
              <ul className={cx(s.groupItems)}>
                {g.items.map((item, i) => {
                  const refs = itemRefs(item);
                  return (
                    <li key={`${item.taskId ?? item.pr?.url ?? item.title}-${String(i)}`}>
                      <a className={cx(s.workItem)} href={itemHref(row.projectRef, item)} aria-label={`${item.title}, ${GROUP_WORDS[g.group]}${refs === "" ? "" : `, ${refs}`}`}>
                        <Truncate expand="none" size="sm">
                          {item.title}
                        </Truncate>
                        {refs === "" ? null : (
                          <Text size="xs" tone="quiet" tabular className={cx(s.refs)}>
                            {refs}
                          </Text>
                        )}
                      </a>
                    </li>
                  );
                })}
                {g.count > g.items.length ? (
                  <li>
                    <Text size="xs" tone="quiet">{`+${String(g.count - g.items.length)} more`}</Text>
                  </li>
                ) : null}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Row outlines only: no word, number or count until this connection has answered. */
function Skeleton() {
  return (
    <div className={cx(s.skeleton)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className={cx(s.skelRow)} />
      ))}
    </div>
  );
}
