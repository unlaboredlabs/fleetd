// A project's pull requests (#/project/<machine>/<project>/prs): the list on the left, open PRs first, and the one
// picked on the right with its description, checks, reviews, where it is on its way to main, the agent that wrote
// it, and its changes. Everything is read through the data layer and refetched on the hub's events; nothing polls.
import { useMemo } from "react";
import type { ProjectRef } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import type { PrRow } from "../../src/data/pr-contract";
import { Breadcrumb, Button, EmptyState, Text } from "../../ui";
import { navigate } from "../shell/navigation";
import type { PrKey } from "../shell/routes";
import { PrDetail } from "./PrDetail";
import { PrList } from "./PrList";
import s from "./prs.module.css";

/** The PR a route names: its own repo, else the project's PR with that number (a chat line knows only the number). */
export const resolvePr = (key: PrKey | null, rows: readonly PrRow[] | undefined): { readonly repo: string; readonly number: number } | "unknown" | undefined => {
  if (key === null) return undefined;
  if (key.repo !== null) return { repo: key.repo, number: key.number };
  if (rows === undefined) return undefined;
  const row = rows.find((r) => r.number === key.number);
  return row === undefined ? "unknown" : { repo: row.repo, number: row.number };
};

export function PrsScreen({ project, pr }: { project: ProjectRef; pr: PrKey | null }) {
  const key = `${project.machineId}/${project.projectId}`;
  const title = useData((st) => st.projects[key]?.title);
  const fresh = useData((st) => st.fresh);
  const list = useToolQuery("pr_list", { projectRef: project });
  const rows = list.data?.prs;
  const picked = resolvePr(pr, rows);
  const selected = picked === undefined || picked === "unknown" ? undefined : picked;
  const row = useMemo(() => (selected === undefined ? undefined : rows?.find((r) => r.repo === selected.repo && r.number === selected.number)), [rows, selected]);
  const hubNow = list.data === undefined ? undefined : Date.parse(list.data.at);

  const toChat = () => navigate({ id: "project", project, message: null });
  const state = list.data !== undefined ? "prs" : list.isError ? "prs.error" : "prs.loading";

  return (
    <div className={s.screen} data-screen={state}>
      <header className={s.header}>
        <Breadcrumb items={[{ label: title ?? "Project", onClick: toChat }, { label: "Pull requests" }]} />
      </header>
      {list.data?.githubError !== undefined ? (
        <div className={s.banner} role="status">
          <Text size="sm" tone="warning">
            GitHub couldn’t be reached, so these are only the PRs fleetd made, without checks.
          </Text>
          <Text size="xs" tone="quiet">
            {list.data.githubError}
          </Text>
        </div>
      ) : null}
      <div className={s.body}>
        <aside className={s.list} aria-label="Pull requests">
          {rows !== undefined ? (
            <PrList rows={rows} project={project} selected={selected} nowMs={hubNow ?? 0} />
          ) : list.isError ? (
            <div className={s.paneNote} role="alert">
              <Text tone="quiet">Couldn’t load the pull requests.</Text>
              <Button onClick={() => void list.refetch()}>Retry</Button>
            </div>
          ) : (
            <div className={s.paneNote} aria-busy={fresh ? "true" : undefined}>
              <Text tone="quiet">{fresh ? "Loading the pull requests…" : "Waiting for the connection…"}</Text>
            </div>
          )}
        </aside>
        <main className={s.detail}>
          {selected !== undefined ? (
            <PrDetail key={`${selected.repo}#${selected.number}`} repo={selected.repo} number={selected.number} row={row} nowMs={hubNow} />
          ) : picked === "unknown" ? (
            <div data-screen="prs.detail.missing" className={s.detailEmpty}>
              <EmptyState title={`#${pr?.number ?? ""} isn’t in this project`}>It may be in another project, or closed more than a week ago.</EmptyState>
            </div>
          ) : rows !== undefined && rows.length > 0 ? (
            <div className={s.detailEmpty}>
              <Text tone="quiet">Pick a pull request to read it here.</Text>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
