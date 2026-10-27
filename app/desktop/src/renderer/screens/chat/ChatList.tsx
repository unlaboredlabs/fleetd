// The lead chat as a virtualized list: only the rows on screen render, each measured to its wrapped height. It
// opens at the newest message and stays there as rows measure and new ones stream in, until the reader scrolls
// (the follow rule is T3 Code's: apps/web MessagesTimeline.logic.ts). Scrolling to the top loads older pages; the
// list keeps its place while they arrive above. Scrolled up, a button counts what arrived below and goes back to it.
import type { Virtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, cx, StateGlyph, Text, useBeatRef, VirtualList } from "../../ui";
import { useData } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { leadDid, leadDoing, leadTurnSince, leadTurnUntil, sentenceCase, turnLine, workedFor } from "./activity";
import type { ChatItem } from "../../src/data/chat";

import { shortClock } from "./format";
import { latestLabel, newestKey, type Arrival, type Row, type TopState } from "./model";
import { MessageView, useEnter } from "./Bubble";
import { useBubbleActions } from "./actions";
import { useLooked } from "./looked";
import { markOf, useShown } from "./shown";
import { RefreshedChanges, RememberedUndo } from "./Remembered";
import { ChatSuggestion } from "../tryit/Suggestion";
import { useNow, useOnScreen } from "../live";
import type { ChatItem as InlineItem } from "../../../shared/contracts";
import { InlineChatItem } from "../inline";
import { isNavi } from "../settings/integrationsModel";
import type { ProjectRef } from "./slots";
import { InlineText } from "./text";
import s from "./view.module.css";

function Top({ state, onLoadOlder }: { state: TopState; onLoadOlder: () => void }) {
  // Reaching the top of what is loaded asks for the page before it. The observer says so once the line is in view,
  // measured after a page that just landed has kept the place: the line it pushed out of view asks for no more.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (state !== "more" || !el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onLoadOlder();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [state, onLoadOlder]);
  return (
    <div ref={ref} className={s.top}>
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
  // In a Navi's chat, an integration's card names the Navi: "Ada wants to send an email".
  const ref = (item.message as { readonly projectRef?: ProjectRef } | undefined)?.projectRef;
  const project = useData((d) => (ref === undefined ? undefined : d.projects[projectKey(ref)]));
  const asker = isNavi(project) ? project?.title : undefined;
  const e = useEnter(enter);
  return (
    <div className={cx(s.message, e.className)} style={e.style} data-entry="inline">
      <Waited id={item.id}>
        {inline !== undefined ? (
          <InlineChatItem item={inline} asker={asker} />
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
  const box = useRef<HTMLDivElement>(null);
  const shown = useShown(box, mark, true);
  return (
    <div ref={box} className={cx(s.waitedBox, shown && s.waited)} tabIndex={shown ? -1 : undefined}>
      {children}
    </div>
  );
}

/** An agent's suggestion to try a PR, flagged to look at: ringed while it is what Show went to, and seen in view. */
function Suggested({ item, project }: { item: ChatItem; project: ProjectRef }) {
  const mark = markOf(useBubbleActions()?.shown, item.id);
  const box = useRef<HTMLDivElement>(null);
  const shown = useShown(box, mark);
  useLooked(box, item.id);
  const suggestion = item.message?.previewSuggestion;
  if (suggestion === undefined) return null;
  return (
    <div className={s.quietRow} data-entry="event">
      <div ref={box} className={cx(s.waitedBox, shown && s.waited)} tabIndex={shown ? -1 : undefined}>
        <ChatSuggestion project={project} suggestion={suggestion} at={shortClock(item.at)} />
      </div>
    </div>
  );
}

/** The lead's activity changes with its frames; the line takes a new value at most once a second. */
const ACTIVITY_EVERY_MS = 1000;

/**
 * The turn line after the lead's reply. While its turn runs: a live glyph (thinking walks its ring, anything else is
 * grain), what it does now in plain words at full strength under the dither scan (base.css), and how long the turn has
 * run, faint, counting; under it, quietly, what the turn did so far. Once over: the done glyph and how long it worked.
 * The words change at most once a second; the count is apart from them, so a screen reader isn't told each tick.
 */
function LeadActivity({ project }: { project: ProjectRef }) {
  const key = projectKey(project);
  const now = useData((st) => {
    const doing = leadDoing(st, key);
    return doing === undefined ? undefined : `${doing}\n${leadDid(st, key)}`;
  });
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
  // The count and the beat stop while the line is out of view, the count too while the window is hidden (useNow).
  const [onScreen, box] = useOnScreen();
  const running = shown !== undefined && since !== undefined && until === undefined;
  const clock = useNow(running && onScreen) + skew;
  // The scan over what it does now steps on the app's beat while on screen, as its glyph does.
  const scan = useBeatRef<HTMLSpanElement>(shown !== undefined && onScreen);
  if (shown === undefined) {
    const line = turnLine({ since, until }, undefined, clock);
    if (line?.words === undefined) return null;
    return (
      <div ref={box} className={cx(s.quietRow, s.turn)} data-entry="activity" data-turn="done" role="status">
        <StateGlyph state="done" size="sm" />
        <Text size="xs" tone="quiet">
          {line.words}
        </Text>
      </div>
    );
  }
  const [doing = "working", did = ""] = shown.split("\n");
  const thinking = doing === "thinking" || doing === "planning";
  return (
    <div ref={box} className={cx(s.quietRow, s.turn)} data-entry="activity" data-turn="running" role="status">
      <StateGlyph state={thinking ? "thinking" : "working"} size="sm" still={!onScreen} />
      <span ref={scan} className={s.turnNow} data-sweep="">
        <InlineText size="xs" text={sentenceCase(doing)} />
      </span>
      {running ? (
        <span className={s.turnTime} aria-hidden>
          {workedFor(clock - since)}
        </span>
      ) : null}
      {did === "" ? null : (
        <span className={s.turnDid}>
          <InlineText size="xs" tone="quiet" text={sentenceCase(did)} />
        </span>
      )}
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
      // An agent's suggestion to try a PR: a line of its own, with Try it (screens/tryit), flagged to look at.
      if (r.item.message?.previewSuggestion !== undefined) return <Suggested item={r.item} project={project} />;
      // The night's memory refresh: its counts, then each change with Undo.
      if (r.item.message?.memoryRefreshed !== undefined) {
        return (
          <div className={s.quietRow} data-entry="event">
            <div className={s.event}>
              <Text size="xs" tone="quiet">
                {r.item.text}
              </Text>
              <span className={s.eventTime}>{shortClock(r.item.at)}</span>
            </div>
            <div className={s.event}>
              <RefreshedChanges project={project} message={r.item.message} refreshed={r.item.message.memoryRefreshed} />
            </div>
          </div>
        );
      }
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
  /** The bubble in it to bring into view (Show's mark), by its key: a message can be taller than the view. */
  openPart?: string | undefined;
  /** Bumped when the reader sends: back to the end. */
  sent?: number;
  /** What came in while the chat was open, by row key (arrivalsOf). */
  entering?: ReadonlyMap<string, Arrival> | undefined;
}) {
  const { rows, openAt, openSeq, openPart, sent, entering } = props;
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
    let tries = 0;
    const pin = () => {
      if (!pinned) return;
      const at = openIndex.current;
      if (openKey === undefined || at === undefined) el.scrollTop = el.scrollHeight;
      // Where you stopped reading goes at the top, with what's new under it.
      else if (openKey === "new") v.scrollToIndex(at, { align: "start" });
      else {
        // A bubble in it goes in the middle itself (the top, if it is taller than the view): a message's middle can
        // be a screen away from it. Until its row has mounted, the row goes there, and then the bubble, a frame on.
        const bubble = openPart === undefined ? null : el.querySelector(`[data-index="${String(at)}"] [data-part="${openPart}"]`);
        if (bubble === null) {
          v.scrollToIndex(at, { align: "center" });
          if (openPart !== undefined && tries++ < 10) requestAnimationFrame(pin);
          return;
        }
        const b = bubble.getBoundingClientRect();
        const top = el.scrollTop + b.top - el.getBoundingClientRect().top;
        v.scrollToOffset(b.height > el.clientHeight ? top : top + b.height / 2 - el.clientHeight / 2);
      }
    };
    if (openKey !== undefined) pin();
    el.addEventListener("wheel", release, { passive: true });
    el.addEventListener("pointerdown", release);
    el.addEventListener("keydown", release);
    const ro = new ResizeObserver(pin);
    ro.observe(inner);
    ro.observe(el);
    return () => {
      release();
      ro.disconnect();
      el.removeEventListener("wheel", release);
      el.removeEventListener("pointerdown", release);
      el.removeEventListener("keydown", release);
    };
  }, [openKey, openSeq, openPart]);

  // An older page keeps the place. TanStack keeps the row at the scroll offset where it was, but at the very top that
  // row is the top line, or the day's line under it, both still first once the page lands below them: the view would
  // stay on the new page, whose top line asks for the one before, and so on to the start. So there the oldest
  // message read before stays where it was.
  const oldest = useRef<{ key: string | number | bigint; start: number }>(undefined);
  useLayoutEffect(() => {
    const v = virtualizer.current;
    if (!v) return;
    const was = oldest.current;
    const first = rows.findIndex((r) => "item" in r);
    const at = was === undefined ? -1 : rows.findIndex((r) => r.key === was.key);
    const row = v.measurementsCache[at];
    const offset = v.scrollOffset ?? 0;
    if (was !== undefined && row !== undefined && at > first && offset < was.start) v.scrollToOffset(offset + row.start - was.start);
    const now = v.measurementsCache[first];
    oldest.current = now === undefined ? undefined : { key: now.key, start: now.start };
  }, [rows]);

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
