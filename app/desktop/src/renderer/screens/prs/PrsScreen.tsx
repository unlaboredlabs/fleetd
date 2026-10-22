// A project's pull requests (#/prs/<machine>/<project>, like the agents view's #/agents): the list on the left, open
// PRs first, and the one picked on the right with its description, checks, reviews, where it is on its way to main,
// the agent that wrote it, and its changes. Everything is read through the data layer and refetched on the hub's
// events; nothing polls.
import { PanelLeft } from "lucide-react";
import { useMemo, useState } from "react";
import type { ProjectRef } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import type { PrListOutput, PrRow } from "../../src/data/pr-contract";
import { Button, Dot, EmptyState, Text, Truncate } from "../../ui";
import type { PrKey } from "../shell/routes";
import { PrDetail, WithCode, type PrTab } from "./PrDetail";
import { PrList } from "./PrList";
import { githubLine, openCount } from "./words";
import s from "./prs.module.css";

/** The PR a route names: its own repo, else the project's PR with that number (a chat line knows only the number). */
export const resolvePr = (key: PrKey | null, rows: readonly PrRow[] | undefined): { readonly repo: string; readonly number: number } | "unknown" | undefined => {
  if (key === null) return undefined;
  if (key.repo !== null) return { repo: key.repo, number: key.number };
  if (rows === undefined) return undefined;
  const row = rows.find((r) => r.number === key.number);
  return row === undefined ? "unknown" : { repo: row.repo, number: row.number };
};

// The tab is the reader's, kept while the app runs: reading diffs one PR after another stays on Changes.
let lastTab: PrTab = "overview";

export function PrsScreen({ project, pr }: { project: ProjectRef; pr: PrKey | null }) {
  const key = `${project.machineId}/${project.projectId}`;
  const title = useData((st) => st.projects[key]?.title);
  const fresh = useData((st) => st.fresh);
  // A link to a project the hub doesn't have (removed, or another hub's) says so instead of asking for its PRs.
  const missing = fresh && title === undefined;
  const list = useToolQuery("pr_list", { projectRef: project }, { enabled: !missing });
  const rows = list.data?.prs;
  const picked = resolvePr(pr, rows);
  const selected = picked === undefined || picked === "unknown" ? undefined : picked;
  const row = useMemo(() => (selected === undefined ? undefined : rows?.find((r) => r.repo === selected.repo && r.number === selected.number)), [rows, selected]);
  const hubNow = list.data === undefined ? undefined : Date.parse(list.data.at);

  // Reading changes, the PR takes the list's room too; Overview or Show the list brings the list back.
  const [tab, setTab] = useState<PrTab>(lastTab);
  const pickTab = (next: PrTab) => {
    lastTab = next;
    setTab(next);
  };
  const wide = tab === "changes" && selected !== undefined;
  const state = list.data !== undefined ? "prs" : list.isError ? "prs.error" : "prs.loading";

  if (missing) {
    return (
      <div className={s.screen} data-screen="prs.missing">
        <EmptyState title="This project isn’t on the hub">It may have been removed.</EmptyState>
      </div>
    );
  }

  const open = rows === undefined ? 0 : openCount(rows);
  return (
    <div className={s.screen} data-screen={state}>
      <header className={s.header}>
        <span className={s.title}>
          <Text strong>Pull requests</Text>
          <span className={s.titleProject}>
            <Truncate size="xs" tone="quiet" expand="none">
              {open > 0 ? `${title ?? ""} · ${String(open)} open` : (title ?? "")}
            </Truncate>
          </span>
        </span>
        {!fresh ? (
          <span className={s.liveness} role="status">
            <Dot color="var(--warning)" />
            <Text size="xs">Not live: reconnecting</Text>
          </span>
        ) : wide ? (
          // Reading changes, the PR has the list's room; this brings the list back.
          <Button variant="quiet" size="sm" icon={<PanelLeft aria-hidden />} onClick={() => pickTab("overview")}>
            Show the list
          </Button>
        ) : null}
      </header>
      {list.data?.githubError !== undefined ? <GitHubBanner list={list.data} onRetry={() => void list.refetch()} /> : null}
      <div className={s.body}>
        <aside className={s.list} aria-label="Pull requests" hidden={wide}>
          {rows !== undefined ? (
            <PrList rows={rows} cut={list.data?.truncated === true} project={project} selected={selected} nowMs={hubNow ?? 0} />
          ) : list.isError ? (
            <div className={s.paneNote} role="alert">
              <Text tone="quiet">Couldn’t read the pull requests.</Text>
              <Button onClick={() => void list.refetch()}>Retry</Button>
            </div>
          ) : (
            <Skeleton busy={fresh} />
          )}
        </aside>
        <main className={s.detail}>
          {selected !== undefined ? (
            <PrDetail key={`${selected.repo}#${selected.number}`} repo={selected.repo} number={selected.number} row={row} nowMs={hubNow} tab={tab} onTab={pickTab} githubSaid={list.data?.githubError !== undefined} />
          ) : picked === "unknown" ? (
            <div data-screen="prs.detail.missing" className={s.detailEmpty}>
              <EmptyState title={`#${pr?.number ?? ""} isn’t in this project`}>It may be in another project, or closed more than a week ago.</EmptyState>
            </div>
          ) : rows !== undefined && rows.length > 0 ? (
            <div className={s.detailEmpty}>
              <EmptyState title="Pick a pull request">Its checks, reviews and changes show here.</EmptyState>
            </div>
          ) : null}
        </main>
      </div>
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

/** Row outlines, no shimmer, as the agents view loads. Busy only while an answer is on its way. */
function Skeleton({ busy }: { busy: boolean }) {
  return (
    <div className={s.skeleton} aria-busy={busy} aria-label="Loading the pull requests">
      <span />
      <span />
      <span />
    </div>
  );
}
