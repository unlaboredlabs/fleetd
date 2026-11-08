// A project's panel, Asked work: each message its lead sent another project's lead (project_message), newest first,
// as one row: the ask in a line, how its order is going as a chip, the project and how long ago. A row opens in place
// to the whole message and the orders opened for it, each by its title, linked to its page; the project's name opens
// its chat. No fleetd ids. Read from the hub's project_asks for this project (#649), again whenever the order board
// changes, since the same events move both.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import { callKey } from "../../src/data/queries";
import { useData, useToolQuery } from "../../src/data/react";
import { PROJECT_TOOLS } from "../projects/model";
import { Button, EmptyState, StatusChip, Text, cx } from "../../ui";
import { orderHref } from "../automations/model";
import { navigate } from "../shell/navigation";
import type { ProjectKey } from "../shell/routes";
import { age, fullWhen } from "../live/when";
import { ASK_STATE, askRows, orderState, type AskRow } from "./askedModel";
import s from "./asked.module.css";

const BOARD = {} as const;

/** This project's asks. */
export const useAskedWork = (project: ProjectKey) => {
  const client = useQueryClient();
  const input = useMemo(() => ({ navi: { machineId: project.machineId, projectId: project.projectId } }), [project.machineId, project.projectId]);
  const query = useToolQuery(PROJECT_TOOLS.asks, input);
  // An order opening, merging or closing moves the board and this read alike: read again when the board does.
  const board = useToolQuery("orders_board", BOARD).dataUpdatedAt;
  useEffect(() => {
    if (board > 0) void client.invalidateQueries({ queryKey: callKey(PROJECT_TOOLS.asks, input), exact: true });
  }, [client, input, board]);
  return query;
};

export function AskedPane({ project }: { project: ProjectKey }) {
  const fresh = useData((st) => st.fresh);
  const query = useAskedWork(project);
  const asks = query.data?.asks;
  const rows = useMemo(() => (asks === undefined ? undefined : askRows(asks)), [asks]);
  // "2d ago": read once a mount.
  const [now] = useState(() => Date.now());

  return (
    <div className={s.screen} data-screen={asks !== undefined ? "asked" : query.isError ? "asked.error" : "asked.loading"}>
      {asks === undefined ? (
        !fresh ? (
          <div className={s.note}>
            <Text tone="quiet">Asked work shows once you’re connected.</Text>
          </div>
        ) : query.isError ? (
          <div className={s.note} role="alert">
            <Text tone="quiet">Couldn’t read the asked work.</Text>
            <Button onClick={() => void query.refetch()}>Retry</Button>
          </div>
        ) : (
          <div className={s.skeleton} aria-busy="true" aria-label="Loading the asked work">
            <span />
            <span />
          </div>
        )
      ) : asks.length === 0 ? (
        <div className={s.empty}>
          <EmptyState title="Nothing asked yet">
            Ask this project’s lead to get something done in another of your projects. Its message goes to that project’s lead, and the order shows here as it moves.
          </EmptyState>
        </div>
      ) : (
        <div className={s.scroll}>
          <ul className={s.rows} aria-label="Asked work">
            {(rows ?? []).map((r) => (
              <AskItem key={r.ask.handle} row={r} now={now} />
            ))}
          </ul>
          {query.data?.truncated === true ? (
            <Text as="p" size="xs" tone="quiet" className={s.note}>
              {`The newest ${String(asks.length)}.`}
            </Text>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** "3h ago"; under a minute, "just now". */
const ago = (iso: string, now: number): string => {
  const a = age(now - new Date(iso).getTime());
  return a === "<1m" ? "just now" : `${a} ago`;
};

function AskItem({ row, now }: { row: AskRow; now: number }) {
  const { ask, summary, state, folded } = row;
  const [open, setOpen] = useState(false);
  const detail = useId();
  const chip = ASK_STATE[state];
  const project = { machineId: ask.to.machineId, projectId: ask.to.projectId };
  return (
    <li className={cx(s.ask, open && s.open)} data-ask={ask.handle} data-state={state}>
      <button type="button" className={s.row} aria-expanded={open} aria-controls={detail} onClick={() => setOpen((o) => !o)}>
        <span className={s.summary}>{summary}</span>
        <span className={s.chip} title={chip.hint}>
          <StatusChip tone={chip.tone} inRow>
            {chip.word}
          </StatusChip>
        </span>
        <span className={s.meta}>
          <span className={s.to}>{ask.toTitle}</span>
          <span aria-hidden>·</span>
          <span className={s.word} title={fullWhen(ask.at)}>
            {ago(ask.at, now)}
          </span>
          {folded ? (
            <>
              <span aria-hidden>·</span>
              <span className={s.word}>Folded into an earlier ask</span>
            </>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className={s.detail} id={detail}>
          <dl className={s.facts}>
            <dt>To</dt>
            <dd>
              <button type="button" className={s.link} title={`Open ${ask.toTitle}’s chat`} onClick={() => navigate({ id: "project", project, message: null })}>
                {ask.toTitle}
              </button>
              <span className={s.quiet}>{` · ${fullWhen(ask.at)}`}</span>
            </dd>
            <dt>{folded ? "Folded into" : ask.orders.length > 1 ? "Orders" : "Order"}</dt>
            {ask.orders.length === 0 ? (
              <dd className={s.quiet}>None yet: its lead hasn’t opened one, or answered in its chat</dd>
            ) : (
              ask.orders.map((o) => (
                <dd key={o.workstreamId} className={s.order}>
                  <span className={s.orderHead}>
                    <a className={s.link} href={orderHref(o.workstreamId)} title={o.title}>
                      {o.title}
                    </a>
                    {ask.orders.length > 1 ? <span className={s.word}>{ASK_STATE[orderState(o)].word}</span> : null}
                  </span>
                  {o.state === "open" && o.headline !== undefined ? <span className={s.quiet}>{o.headline}</span> : null}
                </dd>
              ))
            )}
          </dl>
          <Text as="p" size="sm" className={s.body}>
            {ask.text}
          </Text>
        </div>
      ) : null}
    </li>
  );
}
