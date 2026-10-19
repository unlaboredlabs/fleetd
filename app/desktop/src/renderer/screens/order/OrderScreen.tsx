// The order view (#/order/<id>): the fleet's lanes, PRs and done-when on the left; the project lead's
// conversation about this order on the right, with a receipt under every steer, the line for a steer waiting on
// the lead's next step, and the steer composer at the bottom. Every lane opens its steer box.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Button, cx, Dialog, IdChip, StatusChip, Text, Truncate } from "../../ui";
import { SteerComposer } from "./Composer";
import { Conversation, InlineText } from "./Conversation";
import type { Platform } from "./composer";
import type { AgentLane, Steer, SteerTarget, ThreadRef } from "./contracts";
import { buildConversation, entryIndexAt, fanOut } from "./conversation";
import { jumpFromHash, useOrder, type Jump, type OrderActions, type OrderData } from "./data";
import { ActivityText, Fleet } from "./Fleet";
import { shortModel } from "./format";
import { waitingLine, type ReceiptAct } from "./receipts";
import { hubTailSource, SteerSheet, type SheetAgent, type TailSource } from "./SteerSheet";
import { roleWords, type ToldWho } from "./told";
import { hubToldSource, ToldPanel, type ToldSource } from "./ToldPanel";
import s from "./order.module.css";

/** The one export F1's router mounts, at #/order/<id>[?thread=&item=]. */
export function OrderScreen({ id, jump }: { id: string; jump?: Jump }) {
  const [hashJump] = useState(() => jumpFromHash(location.hash));
  const target = jump ?? hashJump;
  const [data, actions] = useOrder(id, target);
  return (
    <OrderView
      data={data}
      actions={actions}
      platform={window.fleetd.platform}
      told={hubToldSource}
      tail={hubTailSource}
      {...(target ? { jumpItem: target.item } : {})}
    />
  );
}

const WIDE = 1100;

function useWide(ref: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setWide(e.contentRect.width >= WIDE);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return wide;
}

/** Hub time for the waiting line's age; ticks once a second only while something waits. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const t = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(t);
    };
  }, [active]);
  return now;
}

const PHASE_TONE = { waiting_on_you: "needs-you", failed: "failed", done: "done", stopped: "idle" } as const;

function agentOf(lane: AgentLane, workstreamId: string): SheetAgent {
  if (lane.role === "lead" || lane.taskId === undefined) return { lane, target: { workstreamId }, name: "the lead", ref: workstreamId };
  return { lane, target: { taskId: lane.taskId }, name: lane.taskId, ref: lane.taskId };
}

const leadSteers = (steers: readonly Steer[]) => steers.filter((st) => "workstreamId" in st.target);

export function OrderView(props: { data: OrderData; actions: OrderActions; platform: Platform; told: ToldSource; tail: TailSource; jumpItem?: string }) {
  const { data, actions, platform } = props;
  const w = data.workstreamId;
  const root = useRef<HTMLDivElement>(null);
  const wide = useWide(root);
  const [tab, setTab] = useState<"fleet" | "lead">("lead");
  const [sheet, setSheet] = useState<SheetAgent | undefined>(undefined);
  const [toldOpen, setToldOpen] = useState<{ thread: ThreadRef; who: ToldWho; name: string }>();
  const [confirmStop, setConfirmStop] = useState(false);

  const lead = data.lead;
  const leadWorking = lead?.status === "working" || lead?.status === "starting";
  const entries = useMemo(
    () =>
      buildConversation({
        tail: data.tail,
        workstreamId: w,
        events: data.events,
        leadWorking,
        steers: data.steers,
        sending: data.sending,
        streamed: data.streamed,
        lanes: data.lanes,
      }),
    [data.tail, w, data.events, leadWorking, data.steers, data.sending, data.streamed, data.lanes],
  );
  // A jump to the lead's transcript scrolls the log; one to an agent's opens its steer box at the item.
  const focus = data.focus;
  const focusIndex = focus?.at !== undefined && focus.threadId === lead?.threadRef?.threadId ? entryIndexAt(entries, focus.at) : undefined;
  const focusLane = focus && focus.threadId !== lead?.threadRef?.threadId ? data.lanes.find((l) => l.threadRef?.threadId === focus.threadId) : undefined;
  const [jumped, setJumped] = useState<string | undefined>(undefined);
  if (focusLane && jumped !== focusLane.laneId) {
    setJumped(focusLane.laneId);
    setSheet(agentOf(focusLane, w));
  }

  const queuedForLead = leadSteers(data.steers).some((st) => st.stage === "queued");
  const now = useNow(queuedForLead && leadWorking);
  const waiting = waitingLine(leadSteers(data.steers), lead, "the lead’s", now);
  const pill = fanOut(data.lanes, data.asks);
  const status = [pill, data.total ? `${data.settled ?? 0}/${data.total} settled` : undefined].filter(Boolean).join(" · ");
  const finished = data.phase === "stopped" || data.phase === "done" || data.phase === "failed";
  const running = data.lanes.filter((l) => l.status === "working" || l.status === "starting" || l.status === "queued").length;

  // Keep an open sheet's lane live as frames arrive.
  const sheetAgent = sheet ? { ...sheet, lane: (sheet.lane.role === "lead" ? lead : data.lanes.find((l) => l.laneId === sheet.lane.laneId)) ?? sheet.lane } : undefined;

  const onAct = (act: ReceiptAct) => (act.kind === "withdraw" ? actions.withdraw(act.steerId) : actions.redirect(act.steerId));
  const openTold = (agent: SheetAgent) => {
    if (!agent.lane.threadRef) return;
    setToldOpen({
      thread: agent.lane.threadRef,
      name: agent.name,
      who: {
        project: data.projectName,
        orderId: w,
        orderTitle: data.title,
        role: roleWords(agent.lane.role, agent.lane.taskId),
      },
    });
  };
  const steerTo = (target: SteerTarget, text: string, mode: "queue" | "now") => actions.steer(target, text, mode);
  const notice =
    data.tailError !== undefined
      ? { text: data.tailError, error: true }
      : { text: data.status === "loading" ? "Loading the lead’s log…" : `The lead hasn’t said anything about ${w} yet.`, error: false };

  const header = (
    <header className={s.header}>
      <Button variant="ghost" onClick={() => (location.hash = "#/board")}>
        Board
      </Button>
      <nav className={s.crumbs} aria-label="Order">
        {data.projectName ? (
          <>
            <span className={s.crumbProject}>
              <Truncate tone="quiet">{data.projectName}</Truncate>
            </span>
            <span className={s.crumbSep} aria-hidden>
              ›
            </span>
          </>
        ) : null}
        <Text size="sm" mono tone="quiet">
          {w}
        </Text>
        <span className={s.crumbTitle}>
          <Truncate strong>{data.title || w}</Truncate>
        </span>
      </nav>
      {status ? (
        <span className={s.headerStatus}>
          <StatusChip tone={data.phase && data.phase in PHASE_TONE ? PHASE_TONE[data.phase as keyof typeof PHASE_TONE] : "quiet"}>{status}</StatusChip>
        </span>
      ) : null}
      <div className={s.headerActions}>
        <Button variant="ghost" onClick={() => (location.hash = "#/time")}>
          Time
        </Button>
        <Button variant="ghost" onClick={() => (location.hash = `#/status/order/${w}`)}>
          Status
        </Button>
        {finished ? null : (
          <Button variant="secondary" onClick={() => setConfirmStop(true)}>
            Stop
          </Button>
        )}
      </div>
    </header>
  );

  const left = (
    <div className={s.left}>
      <Fleet
        lanes={data.lanes}
        loading={data.status === "loading"}
        prs={data.prs}
        checks={data.doneWhen}
        claim={data.claim}
        summary={pill}
        onOpenLane={(l) => setSheet(agentOf(l, w))}
      />
    </div>
  );

  const leadName = data.projectName ? `Lead · ${data.projectName}` : "Lead";
  const leadState = [lead?.model ? shortModel(lead.model) : undefined, lead?.status].filter(Boolean).join(" · ");
  const right = (
    <div className={s.right} data-screen="order.lead">
      <div className={s.leadHead}>
        <span className={s.leadName}>
          {lead?.threadRef ? <IdChip label={leadName} id={lead.threadRef.threadId} kind="thread" strong /> : <Text strong>{leadName}</Text>}
        </span>
        <span className={s.leadState}>
          <Truncate size="xs" tone="quiet" expand="none">
            {leadState}
          </Truncate>
        </span>
        {lead && leadWorking ? (
          <button type="button" className={s.activityButton} onClick={() => setSheet(agentOf(lead, w))} title="Steer the lead">
            <ActivityText lane={lead} />
          </button>
        ) : null}
        {lead?.threadRef ? (
          <Button variant="ghost" onClick={() => openTold(agentOf(lead, w))}>
            What the lead was told
          </Button>
        ) : null}
      </div>
      <Conversation entries={entries} notice={notice} onAct={onAct} focus={focusIndex} />
      <div className={s.bottom}>
        {waiting ? <InlineText size="xs" tone="quiet" className={cx(s.waiting)} text={waiting} /> : null}
        <SteerComposer
          who={{ name: "the lead", ref: w }}
          platform={platform}
          label="Steer the lead"
          onSend={(text, mode) => steerTo({ workstreamId: w }, text, mode)}
        />
      </div>
    </div>
  );

  // The hub's words for an unknown order name its internals; say it plainly and keep them behind Copy.
  const failure = typeof data.status === "object" ? data.status : undefined;
  const errorText = failure ? (failure.code === "not_found" ? `${w} isn’t on this hub.` : `Couldn’t load ${w}.`) : undefined;
  return (
    <div ref={root} className={cx(s.screen, !wide && s.narrow)} data-screen="order">
      {header}
      {errorText ? (
        <div className={cx(s.logEmpty, s.errorRow)} data-screen="order.error">
          <Text tone={failure?.code === "not_found" ? "quiet" : "danger"}>{errorText}</Text>
          {failure ? <IdChip label="Details" id={failure.error} kind="error" size="xs" tone="quiet" /> : null}
        </div>
      ) : wide ? (
        <div className={s.panes}>
          {left}
          {right}
        </div>
      ) : (
        <>
          <div className={s.tabs} role="tablist">
            <Button variant={tab === "fleet" ? "secondary" : "ghost"} role="tab" aria-selected={tab === "fleet"} onClick={() => setTab("fleet")}>
              Fleet
            </Button>
            <Button variant={tab === "lead" ? "secondary" : "ghost"} role="tab" aria-selected={tab === "lead"} onClick={() => setTab("lead")}>
              Lead
            </Button>
          </div>
          <div className={s.panes}>{tab === "fleet" ? left : right}</div>
        </>
      )}

      <SteerSheet
        agent={sheetAgent}
        steers={data.steers}
        platform={platform}
        nowMs={now}
        tailSource={props.tail}
        {...(props.jumpItem && sheetAgent?.lane.threadRef?.threadId === focus?.threadId ? { focusItem: props.jumpItem } : {})}
        onSteer={steerTo}
        onAct={onAct}
        onTold={openTold}
        onClose={() => setSheet(undefined)}
      />
      <ToldPanel open={toldOpen} projectRef={data.projectRef} source={props.told} onClose={() => setToldOpen(undefined)} />
      <Dialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title={`Stop ${w}?`}
        description={`Its ${running} running ${running === 1 ? "agent is" : "agents are"} cancelled; merged PRs stay. A stopped order isn’t reopened.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmStop(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmStop(false);
                actions.stop();
              }}
            >
              {`Stop ${w}`}
            </Button>
          </>
        }
      />
    </div>
  );
}
