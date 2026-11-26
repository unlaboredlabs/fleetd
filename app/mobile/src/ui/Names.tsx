// fleetd's ids in words a person reads ("T5945 finished W890"), by name: the desktop's RefChip on the phone. An agent's
// or an order's title as the workspace has it now, from the open orders or read once; a plain word for one that is gone
// or a kind with no name. Drawn inside a Text, a weight above the words around it, in their own colour. The id stays in
// what a bubble's Copy takes, the words as written.
import { Fragment, useContext, useEffect, useMemo, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { refWord, splitRefs, type Ref } from "../../../desktop/src/shared/refs";
import { HubContext } from "../hubContext";
import type { Session } from "../session";

/** Titles read once per workspace session: id → title, or null for one the workspace doesn't have. */
const read = new WeakMap<Session, Map<string, string | null>>();
const reading = new WeakMap<Session, Map<string, Promise<void>>>();

const known = (session: Session, id: string): string | null | undefined => read.get(session)?.get(id);

const readTitle = (session: Session, r: Ref): Promise<void> => {
  const busy = reading.get(session) ?? new Map<string, Promise<void>>();
  reading.set(session, busy);
  const going = busy.get(r.id);
  if (going !== undefined) return going;
  const keep = (title: string | null) => {
    const titles = read.get(session) ?? new Map<string, string | null>();
    read.set(session, titles);
    titles.set(r.id, title);
  };
  // Only a workspace that says it has no such thing is an answer: a dropped link is read again by the next one shown.
  const gone = (error: { code: string }) => {
    if (error.code === "not_found") keep(null);
  };
  const call =
    r.kind === "agent"
      ? session.call("task_get", { taskId: r.id }).then((x) => (x.ok ? keep(x.output.task.title) : gone(x.error)))
      : session.call("order_get", { workstreamId: r.id }).then((x) => (x.ok ? keep(x.output.order.title) : gone(x.error)));
  const done = call.catch(() => undefined).finally(() => busy.delete(r.id));
  busy.set(r.id, done);
  return done;
};

/** An agent's or an order's title, live; undefined while it is read or when it can't be known. */
const useTitle = (r: Ref): string | undefined => {
  const hub = useContext(HubContext);
  const orders = hub?.state.orders;
  const session = hub?.session;
  const open = useMemo(() => {
    if (orders === undefined) return undefined;
    if (r.kind === "order") return orders.find((o) => o.workstreamId === r.id)?.title;
    if (r.kind !== "agent") return undefined;
    for (const o of orders) for (const l of o.lanes) if (l.taskId === r.id) return l.title;
    return undefined;
  }, [orders, r.id, r.kind]);
  const [, setRead] = useState(0);
  const wanted = open === undefined && session !== undefined && (r.kind === "agent" || r.kind === "order");
  useEffect(() => {
    if (!wanted || known(session, r.id) !== undefined) return;
    let live = true;
    void readTitle(session, r).then(() => {
      if (live) setRead((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [wanted, session, r]);
  return open ?? (session === undefined ? undefined : (known(session, r.id) ?? undefined));
};

/** One id by its name (inside a Text). */
export function Name({ of }: { of: Ref }) {
  const title = useTitle(of);
  return <Text style={title === undefined ? undefined : styles.name}>{title ?? refWord(of)}</Text>;
}

/** Words with fleetd's ids in them by name (inside a Text). */
export function Names({ text }: { text: string }) {
  const runs = useMemo(() => splitRefs(text), [text]);
  if (runs.length === 1 && typeof runs[0] === "string") return <>{text}</>;
  return (
    <>
      {runs.map((r, i) => (typeof r === "string" ? <Fragment key={i}>{r}</Fragment> : <Name key={i} of={r} />))}
    </>
  );
}

const styles = StyleSheet.create({
  name: { fontWeight: "600" },
});
