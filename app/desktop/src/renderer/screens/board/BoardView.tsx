// The board, drawn from a BoardModel: the docked composer, then either the one open order on the stage or the
// orders grouped by project, then the train and machine strips. Rows come from model.ts; this file draws them.
import { useEffect, type Ref } from "react";
import { Button, StatusChip, Text, Truncate, VirtualList, cx, type StatusTone } from "../../ui";
import { peekNow, useNow } from "./clock";
import { Composer, type ComposerApi, type ComposerHandle } from "./Composer";
import type { Target } from "./composerLogic";
import type { AgentLane, OrderPhase } from "./contracts";
import { groupLabel, nowLane, reviewProgress, writtenIn } from "./fleet";
import { fmtAgo, fmtElapsed, parseMs } from "./format";
import { type ProjectKey, hubNow, machines, needsClock, seenLanes, trains } from "./live";
import { type BoardModel, type Item, type SentOrder, itemKey, leadNote, listItems, stageItems, stagedOrder } from "./model";
import { ActivityLine, Check, LaneRow, Track } from "./parts";
import { type Present, heldLanes, usePresence } from "./presence";
import { MachineStrip, TrainStrip } from "./Strips";
import { describe, isWorking, prLabel, prReview, stageTone } from "./words";
import s from "./Board.module.css";

export interface BoardActions {
  readonly openOrder: (workstreamId: string) => void;
  readonly addProject: () => void;
  /** Opens the inbox on an ask (an order the router couldn't place). */
  readonly openAsk: (askId: string) => void;
  readonly retry: (requestId: string) => void;
  /** Takes a failed order off the board; its text goes back in the composer. */
  readonly edit: (requestId: string) => string | undefined;
  readonly openPr?: ((url: string) => void) | undefined;
}

export interface BoardViewProps {
  readonly model: BoardModel;
  readonly actions: BoardActions;
  readonly composer: ComposerApi;
  readonly composerHandle?: Ref<ComposerHandle> | undefined;
  /** The board filtered to one project (a sidebar click). */
  readonly filter?: ProjectKey | undefined;
  readonly lastUsed?: ProjectKey | undefined;
  readonly offline?: string | undefined;
  /** Told which order is on the stage, so its detail (the agents a card leaves out) can be fetched. */
  readonly onStage?: ((workstreamId: string | undefined) => void) | undefined;
}

const EMPTY: readonly AgentLane[] = [];
const NO_ITEMS: readonly Item[] = [];

const CHIP_TONE: Record<OrderPhase, StatusTone> = {
  waiting_on_you: "needs-you",
  failed: "failed",
  stopped: "idle",
  working: "working",
  reviewing: "working",
  merging: "working",
  verifying: "quiet",
  queued: "quiet",
  planning: "quiet",
  idle: "idle",
  done: "done",
};

export function BoardView({ model, actions, composer, composerHandle, filter, lastUsed, offline, onStage }: BoardViewProps) {
  // The clock ticks only while something on the board changes with time alone.
  const now = hubNow(model.live, useNow(needsClock(model.live, hubNow(model.live, peekNow()))));
  const staged = stagedOrder(model, now, filter);
  const drawn = staged ? heldLanes(staged.lanes, now) : EMPTY;
  const seen = staged ? seenLanes(model.live, staged.card.workstreamId) : EMPTY;
  const stagedId = staged?.card.workstreamId;
  useEffect(() => onStage?.(stagedId), [onStage, stagedId]);
  const items: Item[] = staged ? stageItems(model, staged, drawn, seen) : listItems(model, now, filter);
  // Rows come and go with motion on the stage only. Its rows are few (a card lists at most 12 agents), while the
  // order list is long and virtual, where a row changing height under the virtualizer would move the rows around it.
  const present = usePresence(staged ? items : NO_ITEMS, itemKey);
  const state = staged ? (items.some((i) => i.kind === "finish") ? "finish" : "stage") : items.some((i) => i.kind === "empty") ? "empty" : "list";

  const targets: Target[] = model.projects.map((p) => ({
    key: p.key,
    machineId: p.machineId,
    projectId: p.projectId,
    title: p.title,
    machine: p.machine,
    offline: p.offline,
  }));
  const orders = [...model.live.boards.values()].flatMap((b) => b.orders.map((o) => ({ id: o.workstreamId, title: o.title })));
  const prs = [...model.live.boards.values()].flatMap((b) => b.orders.flatMap((o) => o.prs.map((p) => ({ number: p.number, url: p.url, title: o.title }))));

  return (
    <div className={s.board} data-screen="board">
      <div className={cx(s.top, s.col)}>
        <Composer
          targets={targets}
          selected={filter}
          lastUsed={lastUsed}
          orders={orders}
          prs={prs}
          offline={offline}
          api={composer}
          handle={composerHandle}
          autoFocus
        />
      </div>
      <div className={s.list} data-screen={`board.${state}`}>
        {staged ? (
          <div className={s.stageScroll} role="list" aria-label={staged.card.title}>
            {present.map((p) => (
              <Row key={p.key} present={p} now={now} stale={model.live.stale} actions={actions} composerHandle={composerHandle} />
            ))}
            <div className={s.listEnd} />
          </div>
        ) : (
          <VirtualList
            items={items}
            getKey={itemKey}
            estimateSize={32}
            aria-label="Orders"
            renderItem={(item, i) => (
              <div className={s.col}>
                <ItemView item={item} now={now} stale={model.live.stale} actions={actions} composerHandle={composerHandle} />
                {i === items.length - 1 ? <div className={s.listEnd} /> : null}
              </div>
            )}
          />
        )}
      </div>
      <TrainStrip trains={trains(model.live)} mergedAt={model.live.mergedAt} now={now} {...(actions.openPr ? { onOpenPr: actions.openPr } : {})} />
      <MachineStrip machines={machines(model.live)} slots={model.live.slots} now={now} />
    </div>
  );
}

function Row({
  present,
  now,
  stale,
  actions,
  composerHandle,
}: {
  present: Present<Item>;
  now: number;
  stale: boolean;
  actions: BoardActions;
  composerHandle?: Ref<ComposerHandle> | undefined;
}) {
  return (
    <div role="listitem" className={cx(s.present, present.leaving && s.leaving, present.entering && s.entering)} {...leavingProps(present.leaving)}>
      <div>
        <div className={s.col}>
          <ItemView item={present.item} now={now} stale={stale} actions={actions} composerHandle={composerHandle} />
        </div>
      </div>
    </div>
  );
}

function ItemView({
  item,
  now,
  stale,
  actions,
  composerHandle,
}: {
  item: Item;
  now: number;
  stale: boolean;
  actions: BoardActions;
  composerHandle?: Ref<ComposerHandle> | undefined;
}) {
  switch (item.kind) {
    case "empty":
      return <Empty why={item.why} addProject={actions.addProject} />;
    case "error":
      return (
        <div className={s.errorRow} role="alert">
          <Text size="sm" tone="danger">{`${item.title}: ${item.message}`}</Text>
        </div>
      );
    case "routing":
      return <div className={s.routing}>Routing…</div>;
    case "project":
      return (
        <div className={s.projectHeader}>
          <Truncate strong>{item.title}</Truncate>
          <Truncate size="xs" tone="quiet" expand="none">
            {item.facts}
          </Truncate>
        </div>
      );
    case "sent":
      return <Sent sent={item.sent} actions={actions} composerHandle={composerHandle} />;
    case "card":
      return <OrderCardRow item={item} now={now} stale={stale} open={actions.openOrder} openPr={actions.openPr} />;
    case "stageTitle":
      return <StageTitle item={item} open={actions.openOrder} />;
    case "stageHead":
      return (
        <div className={s.stageHead}>
          <Truncate expand="none">{item.text}</Truncate>
          {stale ? <span className={s.stale}>live feed reconnecting</span> : null}
          {item.sinceMs !== undefined ? <span className={cx(s.clock, s.quietText)}>{fmtElapsed(now - item.sinceMs)}</span> : null}
        </div>
      );
    case "lane":
      return (
        <div className={cx(item.indent && s.indent)}>
          <LaneRow lane={item.lane} density="stage" now={now} stale={stale} />
        </div>
      );
    case "group": {
      const g = item.group;
      const written = writtenIn(g);
      return (
        <div className={s.group}>
          <PrNumber number={g.pr.number} url={g.pr.url} open={actions.openPr} />
          <Truncate expand="none" className={cx(s.groupTitle)}>
            {g.writer?.title ?? `PR #${g.pr.number}`}
          </Truncate>
          <Track state={g.pr.state} review={reviewProgress(g)} />
          <span className={cx(s.label, toneClass(stageTone(g.pr.state)))}>{groupLabel(g)}</span>
          <span className={s.spacer} />
          {written ? (
            <span className={s.written}>
              <Check />
              {written}
            </span>
          ) : null}
        </div>
      );
    }
    case "finish":
      return (
        <div className={s.finish}>
          <Check />
          <Text strong>{item.headline}</Text>
        </div>
      );
    case "finishPr": {
      const g = item.group;
      return (
        <div className={s.finishPr}>
          <span className={s.prNumber}>#{g.pr.number}</span>
          <Truncate expand="none" className={cx(s.groupTitle)}>
            {g.writer?.title ?? `PR #${g.pr.number}`}
          </Truncate>
          <span className={cx(s.label, s.quietText)}>{`${g.checksDone} check${g.checksDone === 1 ? "" : "s"}`}</span>
          <span className={cx(s.label, toneClass(stageTone(g.pr.state)))}>{g.pr.state === "merged" ? "merged" : prLabel(g.pr)}</span>
        </div>
      );
    }
    case "gap":
      return <div className={s.listEnd} />;
  }
}

/** A row on its way out is gone for readers and the keyboard while it collapses. */
const leavingProps = (leaving: boolean) => (leaving ? { "aria-hidden": true, inert: true } : {});

/** "#221", a link to the PR on GitHub when the app can open one; the click stays off the row it sits in. */
function PrNumber({ number, url, open }: { number: number; url: string; open?: ((url: string) => void) | undefined }) {
  if (!open) return <span className={s.prNumber}>#{number}</span>;
  return (
    <button
      type="button"
      className={cx(s.prNumber, s.prLink)}
      aria-label={`Open PR #${number} on GitHub`}
      onClick={(e) => {
        e.stopPropagation();
        open(url);
      }}
    >
      #{number}
    </button>
  );
}

const toneClass = (tone: ReturnType<typeof stageTone>) =>
  tone === "success" ? s.success : tone === "warning" ? s.warning : tone === "danger" ? s.danger : s.quietText;

function StageTitle({ item, open }: { item: Extract<Item, { kind: "stageTitle" }>; open: (id: string) => void }) {
  const { card, lead } = item;
  const leadWorking = lead ? isWorking(lead.status) : false;
  return (
    <div className={s.stageTitle}>
      <div className={s.titleRow}>
        <span className={s.wid}>{card.workstreamId}</span>
        <button type="button" onClick={() => open(card.workstreamId)} aria-label={`Open ${card.title}`}>
          <Truncate size="lg" strong expand="none">
            {card.title}
          </Truncate>
        </button>
        {item.chip !== undefined ? <StatusChip tone={CHIP_TONE[item.phase]}>{item.chip}</StatusChip> : null}
      </div>
      {lead || item.note ? (
        <div className={s.leadRow}>
          <span className={s.leadTag}>lead</span>
          {lead ? <ActivityLine line={describe(lead)} working={leadWorking} /> : null}
          {item.note ? (
            <Truncate tone="quiet" expand="popover">
              {`next: ${item.note}`}
            </Truncate>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function OrderCardRow({
  item,
  now,
  stale,
  open,
  openPr,
}: {
  item: Extract<Item, { kind: "card" }>;
  now: number;
  stale: boolean;
  open: (id: string) => void;
  openPr?: ((url: string) => void) | undefined;
}) {
  const { card, phase, lanes } = item;
  const done = phase === "done" || phase === "stopped";
  const drawn = done ? EMPTY : heldLanes(lanes, now);
  const rows = usePresence(drawn, (l) => l.laneId);
  const speaker = rows.length === 0 && !done ? nowLane(lanes) : undefined;
  const note = done ? undefined : leadNote(card, lanes);
  const created = parseMs(card.createdAt);
  return (
    <div
      className={s.card}
      role="button"
      tabIndex={0}
      data-order={card.workstreamId}
      onClick={() => open(card.workstreamId)}
      onKeyDown={(e) => {
        if (e.key === "Enter") open(card.workstreamId);
      }}
    >
      <div className={s.cardHead}>
        <span className={s.wid}>{card.workstreamId}</span>
        <Truncate strong={!done} tone={done ? "quiet" : "default"} expand="none">
          {card.title}
        </Truncate>
        <span className={s.spacer} />
        {item.chip ? <StatusChip tone={CHIP_TONE[phase]}>{item.label}</StatusChip> : null}
        <span className={s.age}>{created === undefined ? "" : fmtAgo(now - created)}</span>
      </div>
      {rows.length > 0 ? (
        <div className={cx(s.cardBody, s.cardLanes)}>
          {rows.map((r) => (
            <div key={r.key} className={cx(s.present, r.leaving && s.leaving, r.entering && s.entering)} {...leavingProps(r.leaving)}>
              <div>
                <LaneRow lane={r.item} density="card" now={now} stale={stale} />
              </div>
            </div>
          ))}
        </div>
      ) : speaker ? (
        <div className={cx(s.cardBody, s.leadRow)}>
          <ActivityLine line={describe(speaker)} working={isWorking(speaker.status)} stale={stale} />
        </div>
      ) : null}
      {!done && (card.prs.length > 0 || note) ? (
        <div className={cx(s.cardBody, s.prLine)}>
          {card.prs.map((p) => (
            <span key={p.changeId} className={s.prChip}>
              <PrNumber number={p.number} url={p.url} open={openPr} />
              <Track state={p.state} review={prReview(p)} />
              <span className={toneClass(stageTone(p.state))}>{prLabel(p)}</span>
            </span>
          ))}
          {note ? (
            <Truncate size="xs" tone="quiet" expand="none">
              {`next: ${note}`}
            </Truncate>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Sent({ sent, actions, composerHandle }: { sent: SentOrder; actions: BoardActions; composerHandle?: Ref<ComposerHandle> | undefined }) {
  const st = sent.status;
  const chip: [StatusTone, string] =
    st.kind === "sending"
      ? ["idle", sent.to === undefined ? "picking a project" : "sending"]
      : st.kind === "placed"
        ? ["quiet", "planning"]
        : st.kind === "unrouted"
          ? ["needs-you", "needs you"]
          : ["failed", "not sent"];
  return (
    <div className={s.sent}>
      <div className={s.cardHead}>
        <span className={s.wid}>{st.kind === "placed" ? st.workstreamId : ""}</span>
        <Truncate expand="none">{sent.text}</Truncate>
        <span className={s.spacer} />
        <StatusChip tone={chip[0]}>{chip[1]}</StatusChip>
        <span className={s.age} />
      </div>
      {st.kind === "placed" && st.leadWaiting ? (
        <div className={s.sentActions}>
          <Text size="xs" tone="warning">{`Waits for its lead: ${st.leadWaiting}`}</Text>
        </div>
      ) : null}
      {st.kind === "unrouted" ? (
        <div className={s.sentActions}>
          <Text size="xs" tone="quiet">
            The hub couldn't tell which project this is for.
          </Text>
          <Button variant="secondary" onClick={() => actions.openAsk(st.askId)}>
            Pick the project
          </Button>
        </div>
      ) : null}
      {st.kind === "failed" ? (
        <div className={s.sentActions}>
          <Text size="xs" tone="danger">
            {st.message}
          </Text>
          <Button variant="secondary" onClick={() => actions.retry(sent.requestId)}>
            Retry
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              const text = actions.edit(sent.requestId);
              if (text !== undefined && composerHandle && typeof composerHandle === "object") composerHandle.current?.setText(text);
            }}
          >
            Edit
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Empty({ why, addProject }: { why: Extract<Item, { kind: "empty" }>["why"]; addProject: () => void }) {
  switch (why) {
    case "no-projects":
      return (
        <div className={s.empty}>
          <Text size="xl" strong>
            Add a project to start
          </Text>
          <Text tone="quiet">
            A project is a GitHub repo or a folder on one of your machines; each gets its own lead. Add one here, drop a
            folder on this window, or run <span className={s.mono}>fleetd init</span> in a repo on any machine.
          </Text>
          <div className={s.emptyActions}>
            <Button variant="primary" onClick={addProject}>
              Add project…
            </Button>
          </div>
        </div>
      );
    case "loading":
      return (
        <div className={s.empty}>
          <Text tone="quiet">Loading orders…</Text>
        </div>
      );
    case "offline":
      return (
        <div className={s.empty}>
          <Text tone="quiet">Not connected to the hub. The board fills in once it is.</Text>
        </div>
      );
    case "idle":
      return (
        <div className={s.empty}>
          <Text tone="quiet">Nothing running. Type what the fleet should do above, then Enter.</Text>
        </div>
      );
  }
}
