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

/** Each id's title, live, in order; undefined while it is read or when it can't be known. */
const useTitles = (refs: readonly Ref[]): Array<string | undefined> => {
  const hub = useContext(HubContext);
  const orders = hub?.state.orders;
  const session = hub?.session;
  const open = useMemo(
    () =>
      refs.map((r) => {
        if (orders === undefined) return undefined;
        if (r.kind === "order") return orders.find((o) => o.workstreamId === r.id)?.title;
        if (r.kind !== "agent") return undefined;
        for (const o of orders) for (const l of o.lanes) if (l.taskId === r.id) return l.title;
        return undefined;
      }),
    [orders, refs],
  );
  const [, setRead] = useState(0);
  const wanted = useMemo(
    () => (session === undefined ? [] : refs.filter((r, i) => open[i] === undefined && (r.kind === "agent" || r.kind === "order") && known(session, r.id) === undefined)),
    [session, refs, open],
  );
  useEffect(() => {
    if (session === undefined || wanted.length === 0) return;
    let live = true;
    void Promise.all(wanted.map((r) => readTitle(session, r))).then(() => {
      if (live) setRead((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [session, wanted]);
  return refs.map((r, i) => open[i] ?? (session === undefined ? undefined : (known(session, r.id) ?? undefined)));
};

const isRef = (r: string | Ref): r is Ref => typeof r !== "string";

/**
 * Words with fleetd's ids in them as a string with their names, for what a Text can't hold: an accessibility label,
 * which VoiceOver reads out (a chats list's row).
 */
export const useSpoken = (text: string): string => {
  const runs = useMemo(() => splitRefs(text), [text]);
  const refs = useMemo(() => runs.filter(isRef), [runs]);
  const titles = useTitles(refs);
  if (refs.length === 0) return text;
  let i = 0;
  return runs.map((r) => (typeof r === "string" ? r : (titles[i++] ?? refWord(r)))).join("");
};

/** One id by its name (inside a Text); `plain`, in the words' own weight (a chats list's preview). */
export function Name({ of, plain = false }: { of: Ref; plain?: boolean }) {
  const refs = useMemo(() => [of], [of]);
  const [title] = useTitles(refs);
  return <Text style={title === undefined || plain ? undefined : styles.name}>{title ?? refWord(of)}</Text>;
}

/** Words with fleetd's ids in them by name (inside a Text). */
export function Names({ text, plain = false }: { text: string; plain?: boolean }) {
  const runs = useMemo(() => splitRefs(text), [text]);
  if (runs.length === 1 && typeof runs[0] === "string") return <>{text}</>;
  return (
    <>
      {runs.map((r, i) => (typeof r === "string" ? <Fragment key={i}>{r}</Fragment> : <Name key={i} of={r} plain={plain} />))}
    </>
  );
}

const styles = StyleSheet.create({
  name: { fontWeight: "600" },
});
