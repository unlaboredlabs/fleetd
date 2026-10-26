// The panel's PRs: the project's pull requests, open ones first, and (`pr`) one in their place with its description,
// checks, reviews, where it is on its way to main, the agent that wrote it, and its changes. Everything is read
// through the data layer and refetched on the hub's events; nothing polls.
import { useMemo } from "react";
import type { PrListOutput, PrRow, ProjectRef } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { Button, Dot, EmptyState, Text } from "../../ui";
import type { PrKey } from "../shell/routes";
import { PaneEmpty } from "./Bits";
import { PrDetail, WithCode, type PrTab } from "./PrDetail";
import { PrList } from "./PrList";
import { githubLine } from "./words";
import s from "./prs.module.css";

/** The PR a route names: its own repo, else the project's PR with that number (a chat line knows only the number). */
export const resolvePr = (key: PrKey | null, rows: readonly PrRow[] | undefined): { readonly repo: string; readonly number: number } | "unknown" | undefined => {
  if (key === null) return undefined;
  if (key.repo !== null) return { repo: key.repo, number: key.number };
  if (rows === undefined) return undefined;
  const row = rows.find((r) => r.number === key.number);
  return row === undefined ? "unknown" : { repo: row.repo, number: row.number };
};

/** The project's PR list, which the panel's tab counts too: one read, shared. */
export const usePrList = (project: ProjectRef, enabled: boolean) => {
  const title = useData((st) => st.projects[`${project.machineId}/${project.projectId}`]?.title);
  const fresh = useData((st) => st.fresh);
  // A link to a project the hub doesn't have (removed, or another hub's) says so instead of asking for its PRs.
  const missing = fresh && title === undefined;
  return { missing, list: useToolQuery("pr_list", { projectRef: project }, { enabled: enabled && !missing }) };
};

export function PrsPane({ project, pr, tab, onTab }: { project: ProjectRef; pr: PrKey | null; tab: PrTab; onTab: (tab: PrTab) => void }) {
  const fresh = useData((st) => st.fresh);
  const { missing, list } = usePrList(project, true);
  const rows = list.data?.prs;
  const picked = resolvePr(pr, rows);
  const selected = picked === undefined || picked === "unknown" ? undefined : picked;
  const row = useMemo(() => (selected === undefined ? undefined : rows?.find((r) => r.repo === selected.repo && r.number === selected.number)), [rows, selected]);
  const hubNow = list.data === undefined ? undefined : Date.parse(list.data.at);
  const state = list.data !== undefined ? "prs" : list.isError ? "prs.error" : "prs.loading";

  if (missing) {
    return (
      <div className={s.screen} data-screen="prs.missing">
        <EmptyState title="This project isn’t on the hub">It may have been removed.</EmptyState>
      </div>
    );
  }

  return (
    <div className={s.screen} data-screen={state}>
      {!fresh ? (
        <span className={s.liveness} role="status">
          <Dot color="var(--warning)" />
          <Text size="xs">Not live: reconnecting</Text>
        </span>
      ) : null}
      {list.data?.githubError !== undefined ? <GitHubBanner list={list.data} onRetry={() => void list.refetch()} /> : null}
      {selected !== undefined ? (
        <PrDetail key={`${selected.repo}#${selected.number}`} repo={selected.repo} number={selected.number} row={row} nowMs={hubNow} tab={tab} onTab={onTab} githubSaid={list.data?.githubError !== undefined} />
      ) : picked === "unknown" ? (
        <div data-screen="prs.detail.missing" className={s.detailEmpty}>
          <EmptyState title={`#${pr?.number ?? ""} isn’t in this project`}>It may be in another project, or closed more than a week ago.</EmptyState>
        </div>
      ) : rows === undefined && !fresh ? (
        // Nothing held and no hub to ask: "Loading" and bars would never finish.
        <div className={s.paneNote}>
          <Text tone="quiet">{pr === null ? "Pull requests show once you’re connected." : `#${pr.number} shows once you’re connected.`}</Text>
        </div>
      ) : pr !== null ? (
        // The number alone waits for the list to know its repo.
        <div className={s.paneNote} data-screen="prs.detail.loading" aria-busy={!list.isError}>
          <Text tone="quiet">Loading #{pr.number}…</Text>
        </div>
      ) : rows !== undefined ? (
        <PrList rows={rows} cut={list.data?.truncated === true} project={project} nowMs={hubNow ?? 0} />
      ) : list.isError ? (
        <div className={s.listEmpty} role="alert">
          <PaneEmpty title="Couldn’t read the pull requests" action={<Button size="sm" onClick={() => void list.refetch()}>Retry</Button>}>
            The hub didn’t answer this time.
          </PaneEmpty>
        </div>
      ) : (
        <Skeleton />
      )}
    </div>
  );
}

/** GitHub didn't answer the hub: what the list is missing (or that it may be stale), the hub's reason, and Retry. */
function GitHubBanner({ list, onRetry }: { list: PrListOutput; onRetry: () => void }) {
  return (
    <div className={s.banner} role="status">
      <span className={s.bannerText}>
        <Text size="sm" tone="warning">
          {githubLine(list.prs)}
        </Text>
        <Text size="xs" tone="quiet">
          <WithCode text={list.githubError ?? ""} />
        </Text>
      </span>
      <Button variant="quiet" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** Row outlines, a title and its quiet line each, as the list loads; nothing shimmers. */
function Skeleton() {
  return (
    <div className={s.skeleton} aria-busy="true" aria-label="Loading the pull requests">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className={s.skeletonRow}>
          <span />
          <span />
        </span>
      ))}
    </div>
  );
}
