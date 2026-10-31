// A Navi's panel, Asked work: each message it sent another project's lead (project_message), newest first, with the
// orders that lead opened for it and how each is going; the project's name opens its chat. Read from the hub's
// navi_asks for this Navi (#649), again whenever the order board changes, since the same events
// move both. The tab shows only on a hub that serves it (the `navi_asks` feature); a link to it on another hub gets
// a plain sentence, never a guess.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { callKey } from "../../src/data/queries";
import { useData, useToolQuery } from "../../src/data/react";
import { Button, EmptyState, Text } from "../../ui";
import { navigate } from "../shell/navigation";
import type { ProjectKey } from "../shell/routes";
import { when } from "../status/view";
import { NOT_TAKEN, orderWords, type Ask } from "./model";
import s from "./asked.module.css";

/** The hub feature that says it serves navi_asks. */
export const ASKED_FEATURE = "navi_asks";

const BOARD = {} as const;

/** This Navi's asks, once the hub serves them; `served` false otherwise. */
export const useAskedWork = (navi: ProjectKey) => {
  const client = useQueryClient();
  const served = useData((st) => st.features.includes(ASKED_FEATURE));
  const input = useMemo(() => ({ navi: { machineId: navi.machineId, projectId: navi.projectId } }), [navi.machineId, navi.projectId]);
  const query = useToolQuery("navi_asks", input, { enabled: served });
  // An order opening, merging or closing moves the board and this read alike: read again when the board does.
  const board = useToolQuery("orders_board", BOARD).dataUpdatedAt;
  useEffect(() => {
    if (served && board > 0) void client.invalidateQueries({ queryKey: callKey("navi_asks", input), exact: true });
  }, [client, input, served, board]);
  return { served, query };
};

export function AskedPane({ project }: { project: ProjectKey }) {
  const fresh = useData((st) => st.fresh);
  const { served, query } = useAskedWork(project);
  const asks = query.data?.asks;
  // Day-grained stamps: read once a mount.
  const [now] = useState(() => Date.now());

  if (!served) {
    return (
      <div className={s.screen} data-screen="asked.unserved">
        <div className={s.empty}>
          <EmptyState title="This hub doesn’t share asked work with the app">
            Your Navi still asks your projects for work and tells you in its chat when it lands.
          </EmptyState>
        </div>
      </div>
    );
  }
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
            Ask this Navi to get something done in one of your projects. Its message goes to that project’s lead, and the order shows here as it moves.
          </EmptyState>
        </div>
      ) : (
        <div className={s.scroll}>
          <ul className={s.rows} aria-label="Asked work">
            {asks.map((a) => (
              <AskRow key={a.handle} ask={a} now={now} />
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

function AskRow({ ask, now }: { ask: Ask; now: number }) {
  const { machineId, projectId } = ask.to;
  return (
    <li className={s.ask} data-ask={ask.handle}>
      <div className={s.head}>
        <button type="button" className={s.project} title={`Open ${ask.toTitle}`} onClick={() => navigate({ id: "project", project: { machineId, projectId }, message: null })}>
          {ask.toTitle}
        </button>
        <Text size="xs" tone="quiet" className={s.when}>
          {when(ask.at, now)}
        </Text>
      </div>
      <Text as="p" size="sm">
        {ask.text}
      </Text>
      {ask.orders.length === 0 ? (
        <Text size="xs" tone="quiet">
          {NOT_TAKEN}
        </Text>
      ) : (
        <ul className={s.orders}>
          {ask.orders.map((o) => (
            <li key={o.workstreamId} className={s.order}>
              <span className={s.orderHead}>
                <Text size="xs" tone="quiet" tabular>
                  {o.workstreamId}
                </Text>
                <Text size="sm" tone={o.state === "open" ? "default" : "quiet"}>
                  {o.title}
                </Text>
                <Text size="xs" tone="quiet">
                  {orderWords(o)}
                </Text>
              </span>
              {o.state === "open" && o.headline !== undefined ? (
                <Text size="xs" tone="quiet">
                  {o.headline}
                </Text>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
