// A Navi's panel, Asked work: each message it sent another project's lead (project_message), newest first, with the
// orders that lead opened for it and how each is going; the project's name opens its chat. Read from the hub's
// navi_asks for this Navi (#649, docs/design/navi.md), again whenever the order board changes, since the same events
// move both. A hub that doesn't serve it (no `navi_asks` feature) gets a plain sentence, never a guess.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { RawCall } from "../../../shared/contracts";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, EmptyState, Text } from "../../ui";
import { navigate } from "../shell/navigation";
import type { ProjectKey } from "../shell/routes";
import { when } from "../status/view";
import { NOT_TAKEN, orderWords, type Ask, type AskedWorkRead } from "./model";
import s from "./asked.module.css";

/** The hub feature that says it serves navi_asks. */
export const ASKED_FEATURE = "navi_asks";

const BOARD = {} as const;

/** This Navi's asks, once the hub serves them; `served` false otherwise. */
export const useAskedWork = (navi: ProjectKey) => {
  const layer = useDataLayer();
  const client = useQueryClient();
  const fresh = useData((st) => st.fresh);
  const served = useData((st) => st.features.includes(ASKED_FEATURE));
  const input = useMemo(() => ({ navi: { machineId: navi.machineId, projectId: navi.projectId } }), [navi.machineId, navi.projectId]);
  const queryKey = useMemo(() => ["call", "navi_asks", input] as const, [input]);
  const query = useQuery({
    queryKey,
    // Not in the generated contracts until #649 lands on main: the untyped call, read as its shape.
    queryFn: async (): Promise<AskedWorkRead> => {
      const out = await (layer.call as unknown as RawCall)("navi_asks", input);
      if (!out.ok) throw new CallError(out.error);
      return out.output as AskedWorkRead;
    },
    enabled: fresh && served,
  });
  const board = useToolQuery("orders_board", BOARD).dataUpdatedAt;
  useEffect(() => {
    if (served && board > 0) void client.invalidateQueries({ queryKey, exact: true });
  }, [client, queryKey, served, board]);
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
          <EmptyState title="Asked work isn’t on this hub yet">
            When this Navi asks one of your projects for something, the order it becomes and how it’s going show here. Update the hub to a fleetd that shares them with the app.
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
