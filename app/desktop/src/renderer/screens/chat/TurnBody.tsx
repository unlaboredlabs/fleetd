// What a finished lead turn did (TurnList.tsx's stamp opens it): the agents it started (the order's, for
// the reply that closes one), each opening its page, the files they changed, and the links opened: the pages its agents'
// screens and the lead's own reading went to.
import { useMemo } from "react";
import type { Task, WorkStep } from "../../../shared/contracts";
import { changeStat, fileParts, siteOf, turnList, urlsIn, type TurnLink } from "../../../shared/finished";
import { useData, useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { Text, Truncate } from "../../ui";
import { navigate } from "../shell/navigation";
import { panelRoute, type ProjectKey } from "../shell/routes";
import { FEATURE } from "../sessions/hub";
/** A finished lead turn, hub epoch ms at each end. */
export interface TurnRef {
  readonly since: number;
  readonly until: number;
}
import s from "./turn.module.css";

/** A turn's agents are found among the project's newest; an order closes long before it has this many. */
const TASKS_READ = 100;
/** The lead's newest steps, where the links its turn opened are found (agent_work reads 40 at most). */
const LEAD_STEPS = 40;
/** A reply written just after its turn's idle still counts as its (model.ts's REPLY_SLACK_MS). */
const SLACK_MS = 2_000;

const within = (iso: string | undefined, turn: TurnRef): boolean => {
  const t = Date.parse(iso ?? "");
  return !Number.isNaN(t) && t >= turn.since && t <= turn.until + SLACK_MS;
};

export function TurnBody({ turn, order, project, onOpen }: { turn: TurnRef; order: string | undefined; project: ProjectKey; onOpen: () => void }) {
  const projectRef = { machineId: project.machineId, projectId: project.projectId };
  const key = projectKey(project);
  const tasks = useToolQuery("tasks_list", { projectRef, limit: TASKS_READ }).data?.tasks;
  const screensOn = useData((st) => st.features.includes(FEATURE));
  const sessions = useToolQuery("browser_sessions", { projectRef }, { enabled: screensOn }).data?.sessions;
  const lead = useData((st) => st.agents?.find((a) => a.role === "lead" && projectKey(a.projectRef) === key)?.threadRef);
  const leadWork = useToolQuery("agent_work", { machineId: lead?.machineId ?? "", threadId: lead?.threadId ?? "", limit: LEAD_STEPS }, { enabled: lead !== undefined }).data?.steps;
  const list = useMemo(() => {
    if (tasks === undefined) return undefined;
    const ours: Task[] = tasks.filter((t) => t.kind !== "review" && (order !== undefined ? t.workstreamId === order : within(t.createdAt, turn)));
    const ids = new Set(ours.map((t) => t.taskId));
    const links: TurnLink[] = [
      ...(leadWork ?? []).flatMap((step: WorkStep) => (step.kind === "action" && within(step.at, turn) ? urlsIn(step.action.summary) : [])).map((url) => ({ url, label: siteOf(url) })),
      ...(sessions ?? []).flatMap((row) => {
        const url = row.step?.url;
        const ourTurn = row.taskId !== undefined ? ids.has(row.taskId) : within(row.startedAt, turn);
        return url !== undefined && /^https?:/u.test(url) && ourTurn ? [{ url, label: siteOf(url) }] : [];
      }),
    ];
    return turnList(ours, links);
  }, [tasks, sessions, leadWork, turn, order]);
  if (list === undefined) return <div className={s.loading} aria-busy="true" aria-label="Reading what it did" />;
  if (list.agents.length === 0 && list.files.length === 0 && list.links.length === 0) {
    return (
      <Text size="sm" tone="quiet" className={s.empty}>
        It started no agents, changed no files and opened no links.
      </Text>
    );
  }
  return (
    <div className={s.body}>
      {list.agents.length === 0 ? null : (
        <Section label="Agents">
          {list.agents.map((a) => (
            <li key={a.taskId}>
              <button
                type="button"
                className={s.row}
                onClick={() => {
                  onOpen();
                  navigate(panelRoute(project, { tab: "agents", agent: a.taskId }));
                }}
              >
                <Truncate size="sm" expand="none">
                  {a.title}
                </Truncate>
                <Text size="xs" tone={a.state === "failed" ? "danger" : "quiet"} className={s.meta}>
                  {a.line}
                </Text>
              </button>
            </li>
          ))}
        </Section>
      )}
      {list.files.length === 0 ? null : (
        <Section label="Files">
          {list.files.map((f) => {
            const { name, dir } = fileParts(f.path);
            return (
              <li key={f.path} className={s.row} title={f.path}>
                <Truncate size="sm" expand="none">
                  {name}
                </Truncate>
                <Text size="xs" tone="faint" className={s.dir}>
                  {dir}
                </Text>
                <Text size="xs" tone="quiet" className={s.meta}>
                  {changeStat(f.additions, f.deletions)}
                </Text>
              </li>
            );
          })}
        </Section>
      )}
      {list.links.length === 0 ? null : (
        <Section label="Links">
          {list.links.map((l) => (
            <li key={l.url}>
              <a className={s.row} href={l.url} target="_blank" rel="noreferrer" title={l.url}>
                <Truncate size="sm" expand="none">
                  {l.label}
                </Truncate>
              </a>
            </li>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className={s.section} aria-label={label}>
      <Text size="xs" tone="faint">
        {label}
      </Text>
      <ul className={s.list}>{children}</ul>
    </section>
  );
}

