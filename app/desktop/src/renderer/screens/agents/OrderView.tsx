// One order, where its chip lands (`agents/W12`, under the Agents tab): its title and where it stands, its agents at
// work and those that finished, each opening its own view, and its PRs. Read from order_get, which events naming the
// order read again, so it is live; a closed order shows as it ended.
import type { AgentLane, OrderPhase } from "../../../shared/contracts";
import { CallError } from "../../src/data/queries";
import { useToolQuery } from "../../src/data/react";
import { settled } from "../../src/data/store";
import { EmptyState, Text, Truncate } from "../../ui";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import { STATE_WORD } from "./model";
import s from "./agents.module.css";

const PHASE_WORD: Readonly<Record<OrderPhase, string>> = {
  stopped: "Stopped",
  done: "Done",
  waiting_on_you: "Waiting on you",
  working: "Working",
  reviewing: "In review",
  merging: "Merging",
  queued: "Queued",
  planning: "Planning",
  idle: "Idle",
};

/** Whether a route's agent slot names an order rather than an agent. */
export const isOrderId = (id: string): boolean => /^W[1-9]\d*$/u.test(id);

export function OrderView({ project, workstreamId }: { project: ProjectKey; workstreamId: string }) {
  const read = useToolQuery("order_get", { workstreamId });
  const out = read.data;
  if (out === undefined) {
    const gone = read.error instanceof CallError && read.error.error.code === "not_found";
    return read.error === null ? (
      <div className={s.workBody} aria-busy="true" data-screen="agents.order" />
    ) : (
      <div className={s.workBody} data-screen="agents.order">
        <EmptyState title={gone ? "This order isn’t here" : "This order can’t be read now"}>
          {gone ? "The workspace has no such order any more." : "It reads again once the workspace answers."}
        </EmptyState>
      </div>
    );
  }
  const card = out.order;
  const seen = new Set<string>();
  const all = [...card.lanes, ...out.doneLanes].filter((l) => l.role !== "lead" && !seen.has(l.laneId) && Boolean(seen.add(l.laneId)));
  const working = all.filter((l) => !settled(l.status));
  const finished = all.filter((l) => settled(l.status));
  const href = (l: AgentLane) => toHash(panelRoute(project, { tab: "agents", agent: l.taskId ?? l.laneId }));
  const lanes = (title: string, list: readonly AgentLane[]) =>
    list.length === 0 ? null : (
      <div className={s.orderGroup}>
        <Text size="xs" tone="faint">
          {title}
        </Text>
        <ul className={s.orderList}>
          {list.map((l) => (
            <li key={l.laneId}>
              <a className={s.orderRow} href={href(l)}>
                <Truncate size="sm" expand="none">
                  {l.title}
                </Truncate>
                <Text size="xs" tone="quiet">
                  {STATE_WORD[l.status]}
                </Text>
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <section className={s.workBody} aria-label={card.title} data-screen="agents.order">
      <div className={s.workHead}>
        <span className={s.headState}>
          <Text size="xs" tone={card.phase === "waiting_on_you" ? "default" : "quiet"} strong={card.phase === "waiting_on_you"}>
            {PHASE_WORD[card.phase]}
          </Text>
          {card.phaseDetail === undefined ? null : (
            <span className={s.order}>
              <Truncate size="xs" tone="quiet">
                {card.phaseDetail}
              </Truncate>
            </span>
          )}
        </span>
        <Text as="h2" size="md" strong>
          {card.title}
        </Text>
      </div>
      <div className={s.lastWords}>
        {lanes("At work", working)}
        {lanes("Finished", finished)}
        {all.length === 0 ? (
          <Text size="sm" tone="quiet">
            No agents yet.
          </Text>
        ) : null}
        {card.prs.length === 0 ? null : (
          <div className={s.orderGroup}>
            <Text size="xs" tone="faint">
              Pull requests
            </Text>
            <ul className={s.orderList}>
              {card.prs.map((pr) => (
                <li key={`${pr.repo}#${String(pr.number)}`}>
                  <a className={s.orderRow} href={toHash(panelRoute(project, { tab: "prs", pr: { repo: pr.repo, number: pr.number } }))}>
                    <Text size="sm">{`PR #${String(pr.number)}`}</Text>
                    <Text size="xs" tone="quiet">
                      {pr.repo}
                    </Text>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
