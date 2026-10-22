// Status (⌘.): one row per project under one line of column names. A state word, the two-tone progress bar (solid =
// verified, lighter = in flight), agents running, last merged. A row opens the project's chat; its PRs link opens the
// project's PR list. Detail lives in the hovers; nothing estimates time.
// It cannot be stale: the rows come from the data layer (status_projects, refetched on events), which drops every
// answer on a reconnect, so the view is a skeleton until this connection has answered; a row whose source went
// quiet says so.

import { useMemo } from "react";
import type { ProjectStatusRow } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { selectProjectList } from "../../src/data/selectors";
import { Button, cx, Dot, Text, Tooltip, Truncate } from "../../ui";
import { asGetOutput } from "./contracts";
import { barOf, orderRows, STATE_WORDS, type StateWord } from "./rows";
import { dropLines, fullWhen, staleWords, when } from "./view";
import s from "./status.module.css";

const ALL = {} as const;

/** A project's chat (F1's route table). */
export const projectHref = (ref: ProjectStatusRow["projectRef"]): string =>
  `#/project/${encodeURIComponent(ref.machineId)}/${encodeURIComponent(ref.projectId)}`;

/** A project's PR list: its chat's route plus /prs (the PR screen's route table). */
export const prsHref = (ref: ProjectStatusRow["projectRef"]): string => `${projectHref(ref)}/prs`;

/** One phrase wherever there is no bar yet: still planning, or nothing to count. */
const NO_PROGRESS = "no progress yet";

export function StatusScreen() {
  const fresh = useData((st) => st.fresh);
  const query = useToolQuery("status_projects", ALL);
  const projects = useData(selectProjectList);
  const rows = useMemo(() => (query.data === undefined ? undefined : orderRows(query.data.rows, projects)), [query.data, projects]);
  // The hub's clock for "merged 14:02": the newest as-of any row carries.
  const now = rows?.reduce((max, r) => Math.max(max, Date.parse(r.row.asOf) || 0), 0);

  return (
    <div className={cx(s.screen)} data-screen="status.fleet" data-phase={rows === undefined ? "skeleton" : "live"}>
      <header className={cx(s.header)}>
        <Text strong>Status</Text>
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
      </header>
      <div className={cx(s.body)}>
        {rows === undefined ? (
          <Skeleton />
        ) : rows.length === 0 ? (
          <Text tone="quiet">No projects yet.</Text>
        ) : (
          <ul className={cx(s.rows)} aria-label="Projects">
            {/* The column names, once; each row's link reads its cells as a sentence instead. */}
            <li className={cx(s.columns)} aria-hidden>
              {["Project", "State", "Progress", "Agents", "Last merged"].map((h) => (
                <Text key={h} size="xs" tone="quiet" className={cx(h === "Agents" && s.agents)}>
                  {h}
                </Text>
              ))}
            </li>
            {rows.map(({ row, word }) => (
              <Row key={`${row.projectRef.machineId}/${row.projectRef.projectId}`} row={row} state={word} now={now ?? 0} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const TONE = { waiting_on_you: "warning", blocked: "danger", working: "default", idle: "quiet" } as const;

function Row({ row, state, now }: { row: ProjectStatusRow; state: StateWord; now: number }) {
  const { bar, planning } = barOf(row);
  const merged = row.lastMerged;
  const mergedAt = merged === undefined ? "" : when(merged.at, now || Date.parse(merged.at));
  const label = [
    `${row.title}: ${STATE_WORDS[state]}`,
    bar === null ? NO_PROGRESS : `${bar.pct}% done`,
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
        {bar !== null ? (
          <Tooltip content={<Drops row={row} pct={bar} />}>
            <span className={cx(s.progress)} tabIndex={0}>
              <span className={cx(s.bar)} role="img" aria-label={`${bar.pct}% done, ${bar.verifiedPct}% verified`}>
                <span className={cx(s.barVerified)} style={{ width: `${bar.verifiedPct}%` }} />
                <span className={cx(s.barInFlight)} style={{ width: `${bar.inFlightPct}%` }} />
              </span>
              <Text size="sm" tabular>{`${bar.pct}%`}</Text>
            </span>
          </Tooltip>
        ) : planning ? (
          <Tooltip content="The lead is still planning the work.">
            <span className={cx(s.progress)} tabIndex={0}>
              <Text size="xs" tone="quiet">
                {NO_PROGRESS}
              </Text>
            </span>
          </Tooltip>
        ) : (
          <span className={cx(s.progress)}>
            <Text size="xs" tone="quiet">
              {NO_PROGRESS}
            </Text>
          </span>
        )}
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
      <a className={cx(s.prs)} href={prsHref(row.projectRef)} aria-label={`${row.title}: pull requests`}>
        <Text size="xs" tone="quiet">
          PRs
        </Text>
      </a>
    </li>
  );
}

/** The bar's hover: verified and in flight, then why it last fell. The drops are in the project's own status doc,
 * read only while this hover is open. */
function Drops({ row, pct }: { row: ProjectStatusRow; pct: { pct: number; verifiedPct: number; inFlightPct: number } }) {
  const query = useToolQuery("status_get", { scope: { kind: "project", projectRef: row.projectRef } });
  const doc = query.data === undefined ? undefined : asGetOutput(query.data)?.doc;
  const lines = doc === undefined ? [] : dropLines(doc.progress.estimate?.series ?? []);
  return (
    <span className={cx(s.drops)}>
      <span>{`${pct.pct}% done: ${pct.verifiedPct}% verified, ${pct.inFlightPct}% in flight`}</span>
      {lines.map((l) => (
        <span key={l}>{l}</span>
      ))}
    </span>
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
