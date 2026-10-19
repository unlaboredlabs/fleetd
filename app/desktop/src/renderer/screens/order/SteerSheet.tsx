// The steer box on every agent (steering-spec §3, §7): its role and what it is doing now, its last items, the
// steers sent to it with their receipts, and a composer aimed at it with the same two keys. A steer to a task also
// reaches the order's lead as a line in its next wake, so the lead's plan doesn't fork; the sheet says so.

import { useEffect, useRef, useState } from "react";
import { Button, cx, IdChip, RoleTag, Sheet, Text } from "../../ui";
import { SteerComposer } from "./Composer";
import { FleetdText, InlineText, Message, ReceiptLine, type ReceiptHandlers } from "./Conversation";
import type { Platform } from "./composer";
import type { AgentLane, Steer, SteerMode, SteerTarget, TailItem, ThreadRef } from "./contracts";
import { ActivityText } from "./Fleet";
import { clock } from "./format";
import { receipt, sendingReceipt, waitingLine } from "./receipts";
import { taskOfTarget, type Sending } from "./sending";
import type { SendOutcome } from "./data";
import { roleWords } from "./told";
import s from "./order.module.css";

/** The newest `n` items oldest first, or (with `item`) the window around that item and its index. */
export type TailSource = (
  thread: ThreadRef,
  n: number,
  item?: string,
) => Promise<{ items: readonly TailItem[]; focus?: number | undefined } | { error: string }>;

export const hubTailSource: TailSource = async (thread, n, item) => {
  if (item !== undefined) {
    const r = await window.fleetd.hub.call("thread_window", { machineId: thread.machineId, threadId: thread.threadId, itemId: item, before: 25, after: 25 });
    return r.ok ? (r.output as { items: readonly TailItem[]; focus?: number }) : { error: r.error.message };
  }
  const r = await window.fleetd.hub.call("thread_tail", { machineId: thread.machineId, threadId: thread.threadId, n });
  return r.ok ? { items: [...(r.output as { items: readonly TailItem[] }).items].reverse() } : { error: r.error.message };
};

export interface SheetAgent {
  readonly lane: AgentLane;
  readonly target: SteerTarget;
  /** "the lead", "T88". */
  readonly name: string;
  readonly ref: string;
}

function Items({ thread, source, focusItem }: { thread: ThreadRef | undefined; source: TailSource; focusItem?: string | undefined }) {
  const [state, setState] = useState<Awaited<ReturnType<TailSource>> | undefined>(undefined);
  const machineId = thread?.machineId;
  const threadId = thread?.threadId;
  const lit = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (machineId === undefined || threadId === undefined) return;
    let live = true;
    void source({ machineId, threadId }, 20, focusItem).then((r) => {
      if (live) setState(r);
    });
    return () => {
      live = false;
    };
  }, [machineId, threadId, source, focusItem]);
  const focus = state && "items" in state ? state.focus : undefined;
  useEffect(() => {
    if (focus !== undefined) lit.current?.scrollIntoView({ block: "center" });
  }, [focus]);
  if (thread === undefined) return <Text tone="quiet">It hasn’t started yet.</Text>;
  if (state === undefined) return <Text tone="quiet">Loading its last items…</Text>;
  if ("error" in state)
    return (
      <div className={s.errorRow}>
        <Text tone="quiet">Couldn’t load its last items.</Text>
        <IdChip label="Details" id={state.error} kind="error" size="xs" tone="quiet" />
      </div>
    );
  if (state.items.length === 0) return <Text tone="quiet">Nothing yet.</Text>;
  return (
    <div className={s.sheetItems}>
      {state.items.map((i, n) =>
        i.kind === "action" ? (
          <div key={n} ref={n === focus ? lit : undefined} className={cx(s.sheetItem, n === focus && s.lit)}>
            <span className={s.time}>{clock(i.at)}</span>
            <Text mono className={cx(s.call, i.action.failed && s.callFailed)}>
              {i.action.summary}
            </Text>
          </div>
        ) : i.role === "system" ? null : (
          <div key={n} ref={n === focus ? lit : undefined} className={cx(s.sheetItem, n === focus && s.lit)}>
            <span className={s.time}>{clock(i.at)}</span>
            {i.role === "user" ? <FleetdText text={i.text} /> : <Message text={i.text} />}
          </div>
        ),
      )}
    </div>
  );
}

export function SteerSheet(
  props: {
    agent: SheetAgent | undefined;
    steers: readonly Steer[];
    platform: Platform;
    nowMs: number;
    tailSource: TailSource;
    /** Open at this transcript item (a time inspector jump). */
    focusItem?: string;
    onSteer: (target: SteerTarget, text: string, mode: SteerMode, requestId: string) => Promise<SendOutcome>;
    /** Steers on their way to the hub, and refused ones. */
    sending: readonly Sending[];
    redirected: ReadonlySet<string>;
    onTold: (agent: SheetAgent) => void;
    onClose: () => void;
  } & ReceiptHandlers,
) {
  const { agent } = props;
  const isLead = agent !== undefined && "workstreamId" in agent.target;
  const mine = agent
    ? props.steers.filter((st) => ("taskId" in agent.target ? "taskId" in st.target && st.target.taskId === agent.target.taskId : "workstreamId" in st.target))
    : [];
  const pending = agent ? props.sending.filter((p) => taskOfTarget(p.target) === taskOfTarget(agent.target)) : [];
  const waiting = agent ? waitingLine(mine, agent.lane, `${agent.name}’s`, props.nowMs) : undefined;
  const title = agent ? (isLead ? "Steer the lead" : `Steer ${roleWords(agent.lane.role, agent.lane.taskId)}`) : "";
  return (
    <Sheet
      open={agent !== undefined}
      onOpenChange={(o) => {
        if (!o) props.onClose();
      }}
      title={title}
      description={agent?.lane.title}
    >
      {agent ? (
        <div className={s.sheetBody} data-screen="order.steer">
          <div className={s.laneActivity}>
            <span className={s.flexNone}>
              <RoleTag role={agent.lane.role} />
            </span>
            <ActivityText lane={agent.lane} />
          </div>
          {agent.lane.threadRef ? (
            <div>
              <Button variant="ghost" onClick={() => props.onTold(agent)}>
                {`What ${agent.name} was told`}
              </Button>
            </div>
          ) : null}

          <div className={s.section}>
            <span className={s.sectionLabel}>Its last items</span>
          </div>
          <Items thread={agent.lane.threadRef} source={props.tailSource} focusItem={props.focusItem} />

          {mine.length + pending.length > 0 ? (
            <>
              <div className={s.section}>
                <span className={s.sectionLabel}>Steers</span>
              </div>
              {mine.map((st) => (
                <div key={st.id} className={s.sheetItem}>
                  <span className={s.time}>{clock(st.queuedAt)}</span>
                  <div className={s.body}>
                    <Text size="xs" tone="quiet">
                      {st.by.kind === "lead" ? "The lead" : "You"}
                    </Text>
                    <Message text={st.text} />
                    <ReceiptLine receipt={receipt(st, props.redirected.has(st.id))} onAct={props.onAct} />
                  </div>
                </div>
              ))}
              {pending.map((p) => (
                <div key={p.requestId} className={s.sheetItem}>
                  <span className={s.time}>{clock(p.at)}</span>
                  <div className={s.body}>
                    <Text size="xs" tone="quiet">
                      You
                    </Text>
                    <Message text={p.text} />
                    <ReceiptLine receipt={sendingReceipt(p)} onAct={props.onAct} />
                  </div>
                </div>
              ))}
            </>
          ) : null}

          {isLead ? null : (
            <Text size="xs" tone="quiet" className={cx(s.leadTold)}>
              {`The lead is told: its next wake says you steered ${agent.ref} and what you said, so its plan and any message it sends ${agent.ref} stay in line. It isn’t interrupted.`}
            </Text>
          )}
          {waiting ? <InlineText size="xs" tone="quiet" text={waiting} /> : null}
          <SteerComposer
            who={{ name: agent.name, ref: agent.ref }}
            platform={props.platform}
            label={`Steer ${agent.name}`}
            autoFocus
            onSend={(text, mode, requestId) => props.onSteer(agent.target, text, mode, requestId)}
          />
        </div>
      ) : null}
    </Sheet>
  );
}
