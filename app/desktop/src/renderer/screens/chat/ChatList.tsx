// The lead chat as a virtualized list: only the rows on screen render, each measured to its wrapped height. It
// opens at the newest message and stays there as rows measure and new ones stream in, until the reader scrolls
// (the follow rule is T3 Code's: apps/web MessagesTimeline.logic.ts). Scrolling to the top loads older pages; the
// list keeps its place while they arrive above. Scrolled up, a button counts what arrived below and goes back to it.
import type { Virtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, cx, Text, VirtualList } from "../../ui";
import { useData } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { leadActivity, leadTurnSince, leadTurnUntil, turnLine } from "./activity";
import type { ChatItem } from "../../src/data/chat";

import { shortClock } from "./format";
import { latestLabel, newestKey, type Arrival, type Row, type TopState } from "./model";
import { MessageView, useEnter } from "./Bubble";
import { useBubbleActions } from "./actions";
import { markOf, useShown } from "./shown";
import { RememberedUndo } from "./Remembered";
import { LiveStrip, useNow, useOnScreen } from "../live";
import { Boundary } from "../../src/Boundary";
import type { ChatItem as InlineItem } from "../../../shared/contracts";
import { InlineChatItem } from "../inline";
import type { ProjectRef } from "./slots";
import { InlineText } from "./text";
import s from "./view.module.css";

function Top({ state, onLoadOlder }: { state: TopState; onLoadOlder: () => void }) {
  // Reaching the top of what is loaded asks for the page before it.
  useEffect(() => {
    if (state === "more") onLoadOlder();
  }, [state, onLoadOlder]);
  return (
    <div className={s.top}>
      {state === "loading" ? (
        <Text size="xs" tone="quiet">
          Loading earlier messages…
        </Text>
      ) : state === "more" ? (
        <Button variant="ghost" onClick={onLoadOlder}>
          Load earlier messages
        </Button>
      ) : state === "held" ? (
        <Text size="xs" tone="quiet">
          Earlier messages load once you’re connected.
        </Text>
      ) : state === "reread" ? (
        <Text size="xs" tone="quiet">
          Earlier messages load once the newest are read.
        </Text>
      ) : (
        <Text size="xs" tone="quiet">
          This is the start of the conversation.
        </Text>
      )}
    </div>
  );
}

/**
 * A secret field or a gated command (F5). The hub's message carries the item; E1's stub contract doesn't type it
 * yet, so it is read from the message here until E1 moves to H1's generated contract.
 */
function Inline({ item, enter }: { item: ChatItem; enter: Arrival | undefined }) {
  const inline = (item.message as { readonly item?: InlineItem } | undefined)?.item;
  const e = useEnter(enter);
  return (
    <div className={cx(s.message, e.className)} style={e.style} data-entry="inline">
      <Waited id={item.id}>
        {inline !== undefined ? (
          <InlineChatItem item={inline} />
        ) : (
          <Text size="xs" tone="quiet">
            {item.kind === "secret" ? "The lead needs a secret here." : "The lead wants to run a command that needs your approval."}
          </Text>
        )}
      </Waited>
    </div>
  );
}

/** An approval or a secret, ringed while it is what Show went to; its card takes the focus. */
function Waited({ id, children }: { id: string; children: ReactNode }) {
  const mark = markOf(useBubbleActions()?.shown, id);
  const ref = useShown<HTMLDivElement>(mark, true);
  return (
    <div ref={ref} className={cx(s.waitedBox, mark !== undefined && s.waited)} tabIndex={mark === undefined ? undefined : -1}>
      {children}
    </div>
  );
}

/** The lead's activity changes with its frames; the line takes a new value at most once a second. */
const ACTIVITY_EVERY_MS = 1000;

/** The quiet line after the lead's reply: how long its turn has run (counting up, once a second) and what it does. */
function LeadActivity({ project }: { project: ProjectRef }) {
  const key = projectKey(project);
  const now = useData((st) => leadActivity(st, key));
  const since = useData((st) => leadTurnSince(st, key));
  const until = useData((st) => leadTurnUntil(st, key));
  const skew = useData((st) => st.live.skewMs ?? 0);
  const [shown, setShown] = useState(now);
  const at = useRef(0);
  useEffect(() => {
    if (now === shown) return;
    const timer = setTimeout(
      () => {
        at.current = Date.now();
        setShown(now);
      },
      Math.max(0, at.current + ACTIVITY_EVERY_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [now, shown]);
  const box = useRef<HTMLDivElement>(null);
  // The count stops while the line is out of view or the window hidden (useNow).
  const onScreen = useOnScreen(box);
  const clock = useNow(shown !== undefined && since !== undefined && until === undefined && onScreen) + skew;
  const line = turnLine({ since, until }, shown, clock);
  if (line === undefined) return null;
  return (
    <div ref={box} className={s.quietRow} data-entry="activity" role="status">
      {line.count !== undefined ? (
        <span aria-hidden>
          <Text size="xs" tone="quiet" tabular>
            {line.words === undefined ? line.count : `${line.count} · `}
          </Text>
        </span>
      ) : null}
      {line.words !== undefined ? <InlineText size="xs" tone="quiet" text={line.words} /> : null}
    </div>
  );
}

const RowView = memo(function RowView(props: {
  row: Row;
  project: ProjectRef;
  /** This is the person's newest message: its receipt shows even once sent. */
  mineLatest: boolean;
  /** It came in while the chat was open: it enters. */
  enter: Arrival | undefined;
  onLoadOlder: () => void;
}) {
  const { row: r, project } = props;
  switch (r.kind) {
    case "top":
      return <Top state={r.state} onLoadOlder={props.onLoadOlder} />;
    case "history":
      return (
        <div className={s.day} role="separator">
          <Text size="xs" tone="quiet">
            From before this chat
          </Text>
        </div>
      );
    case "day":
      return (
        <div className={s.day} role="separator">
          <Text size="xs" tone="quiet">
            {r.label}
          </Text>
        </div>
      );
    case "new":
      return (
        <div className={s.day} role="separator">
          <Text size="xs" tone="accent">
            New
          </Text>
        </div>
      );
    case "event":
      return (
        <div className={cx(s.quietRow, s.event)} data-entry="event">
          <InlineText size="xs" tone="quiet" text={r.item.text} project={project} />
          {r.item.message ? <RememberedUndo project={project} message={r.item.message} /> : null}
          <span className={s.eventTime}>{shortClock(r.item.at)}</span>
        </div>
      );
    case "inline":
      return <Inline item={r.item} enter={props.enter} />;
    case "activity":
      return <LeadActivity project={project} />;
    case "strip":
      return (
        <div className={s.strip}>
          <Boundary part="the live strip">
            <LiveStrip project={project} />
          </Boundary>
        </div>
      );
    case "time":
      return (
        <div className={s.clock} role="separator">
          <Text size="xs" tone="quiet" tabular>
            {r.label}
          </Text>
        </div>
      );
    case "message":
      return <MessageView row={r} mineLatest={props.mineLatest} enter={props.enter} />;
  }
});

export function ChatList(props: {
  rows: readonly Row[];
  project: ProjectRef;
  onLoadOlder: () => void;
  /** A message to open at (a notification's link): scrolled to once it is loaded. */
  openAt?: number | undefined;
  /** Bumped to scroll to `openAt` again (Show, pressed twice). */
  openSeq?: number | undefined;
  /** Bumped when the reader sends: back to the end. */
  sent?: number;
  /** What came in while the chat was open, by row key (arrivalsOf). */
  entering?: ReadonlyMap<string, Arrival> | undefined;
}) {
  const { rows, openAt, openSeq, sent, entering } = props;
  const virtualizer = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const mineLatest = useMemo(() => rows.findLast((r) => r.kind === "message" && r.item.author === "human")?.key, [rows]);

  // Open at the newest row and keep the end in view as rows measure and stream, until the reader scrolls. A link
  // (a notification's, or Show) opens the chat at a message instead, and keeps that message in view the same way:
  // through rows measuring and the window resizing, until the reader scrolls. Keyed by the message, not its index,
  // so older pages loading above it don't pin it again.
  const openKey = openAt === undefined ? undefined : rows[openAt]?.key;
  const openIndex = useRef(openAt);
  const rowsNow = useRef(rows);
  useEffect(() => {
    openIndex.current = openAt;
    rowsNow.current = rows;
  });
  /** Lets go of the pin: the reader scrolled, or asked for the newest message. */
  const unpin = useRef<() => void>(undefined);
  useEffect(() => {
    const v = virtualizer.current;
    const el = v?.scrollElement;
    const inner = el?.firstElementChild;
    if (!v || !el || !inner) return;
    let pinned = true;
    const release = () => {
      pinned = false;
    };
    unpin.current = release;
    const pin = () => {
      if (!pinned) return;
      const at = openIndex.current;
      if (openKey === undefined || at === undefined) el.scrollTop = el.scrollHeight;
      // Where you stopped reading goes at the top, with what's new under it.
      else v.scrollToIndex(at, { align: openKey === "new" ? "start" : "center" });
    };
    if (openKey !== undefined) pin();
    el.addEventListener("wheel", release, { passive: true });
    el.addEventListener("pointerdown", release);
    el.addEventListener("keydown", release);
    const ro = new ResizeObserver(pin);
    ro.observe(inner);
    ro.observe(el);
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", release);
      el.removeEventListener("pointerdown", release);
      el.removeEventListener("keydown", release);
    };
  }, [openKey, openSeq]);

  // Scrolled up past the follow threshold (followOptions'), the newest message's key then; undefined at the end.
  const [awayFrom, setAwayFrom] = useState<string>();
  useEffect(() => {
    const el = virtualizer.current?.scrollElement;
    if (!el) return;
    const onScroll = () => {
      const away = el.scrollHeight - el.scrollTop - el.clientHeight > 24;
      setAwayFrom((from) => (away ? (from ?? newestKey(rowsNow.current)) : undefined));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  const latest = latestLabel(rows, awayFrom);
  const toLatest = () => {
    unpin.current?.();
    virtualizer.current?.scrollToIndex(rows.length - 1, { align: "end" });
  };

  useEffect(() => {
    const v = virtualizer.current;
    if (sent === undefined || sent === 0 || !v) return;
    v.scrollToIndex(rows.length - 1, { align: "end" });
    // Once per send.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent]);

  return (
    <div className={s.log}>
      <VirtualList
        items={rows}
        getKey={(r) => r.key}
        estimateSize={56}
        followOutput
        startAtEnd
        className={s.scroller}
        virtualizerRef={virtualizer}
        aria-label="Conversation with the lead"
        renderItem={(r) => (
          <RowView
            row={r}
            project={props.project}
            mineLatest={r.key === mineLatest}
            enter={entering?.get(r.key)}
            onLoadOlder={props.onLoadOlder}
          />
        )}
      />
      {latest !== undefined ? (
        <div className={s.latest}>
          {/* A press keeps the cursor in the box: it would otherwise go to the button, which then goes. */}
          <Button variant="secondary" onMouseDown={(e) => e.preventDefault()} onClick={toLatest}>
            {latest} <span aria-hidden>↓</span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
