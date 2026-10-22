// The lead chat as a virtualized list: only the rows on screen render, each measured to its wrapped height. It
// opens at the newest message and stays there as rows measure and new ones stream in, until the reader scrolls
// (the follow rule is T3 Code's: apps/web MessagesTimeline.logic.ts). Scrolling to the top loads older pages; the
// list keeps its place while they arrive above.
import type { Virtualizer } from "@tanstack/react-virtual";
import { Paperclip } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { AgentLane, AttachmentRef } from "../../../shared/contracts";
import { Button, cx, Text, Truncate, VirtualList } from "../../ui";
import { useData, useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { leadActivity, leadTurnSince, leadTurnUntil, turnLine } from "./activity";
import { fmtBytes } from "./attachments";
import type { ChatItem } from "../../src/data/chat";

import { shortClock } from "./format";
import { systemHeadline, type Row, type TopState } from "./model";
import { MessageReceipt } from "./Composer";
import { LiveStrip, useNow, useOnScreen } from "../live";
import { Boundary } from "../../src/Boundary";
import type { ChatItem as InlineItem } from "../../../shared/contracts";
import { InlineChatItem } from "../inline";
import type { ProjectRef } from "./slots";
import { Disclosure, InlineText, Message } from "./text";
import s from "./view.module.css";

/**
 * An attachment as a chip. The chat contract carries only its id (no name, type or size yet), so it reads
 * "Attachment n" with the id behind copy, never as text.
 */
function FileChip({ file }: { file: AttachmentRef }) {
  return (
    <span className={s.attachment}>
      <Paperclip className={s.attachmentIcon} aria-hidden />
      {/* A file name is a machine token (pasted-1.txt, receipt-dates.png): the code voice, cut to fit. */}
      <span className={s.attachmentName} data-text="code">
        <Truncate size="sm" mono>
          {file.name}
        </Truncate>
      </span>
      <Text size="xs" tone="quiet" tabular>
        {fmtBytes(file.bytes)}
      </Text>
    </span>
  );
}

// An image shows itself, fetched once its row is on screen (the list only mounts visible rows). Until then, and
// if it can't be read, it is a file like any other.
function ImageAttachment({ project, file }: { project: ProjectRef; file: AttachmentRef }) {
  const got = useToolQuery("attachment_get", { projectRef: project, attachmentId: file.attachmentId });
  if (got.data === undefined) return <FileChip file={file} />;
  return (
    <img
      className={s.attachmentImage}
      src={`data:${got.data.mime};base64,${got.data.dataB64}`}
      alt={file.name}
      title={file.name}
    />
  );
}

function Attachment({ project, file }: { project: ProjectRef; file: AttachmentRef }) {
  return file.mime.startsWith("image/") ? <ImageAttachment project={project} file={file} /> : <FileChip file={file} />;
}

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

function Bottom({ state, onLoadNewer, onJumpToLatest }: { state: "more" | "loading"; onLoadNewer: () => void; onJumpToLatest: () => void }) {
  // Reaching the bottom of what is loaded asks for the page after it.
  useEffect(() => {
    if (state === "more") onLoadNewer();
  }, [state, onLoadNewer]);
  return (
    <div className={s.top}>
      {state === "loading" ? (
        <Text size="xs" tone="quiet">
          Loading later messages…
        </Text>
      ) : (
        <Button variant="secondary" onClick={onJumpToLatest}>
          Jump to latest
        </Button>
      )}
    </div>
  );
}

function SystemLine({ item }: { item: ChatItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={s.quietRow}>
      <Disclosure open={open} onToggle={() => setOpen((o) => !o)}>
        {systemHeadline(item.text)}
      </Disclosure>
      {open ? (
        <div className={s.systemText}>
          <Message text={item.text} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A secret field or a gated command (F5). The hub's message carries the item; E1's stub contract doesn't type it
 * yet, so it is read from the message here until E1 moves to H1's generated contract.
 */
function Inline({ item }: { item: ChatItem }) {
  const inline = (item.message as { readonly item?: InlineItem } | undefined)?.item;
  if (inline !== undefined) return <InlineChatItem item={inline} />;
  return (
    <Text size="xs" tone="quiet">
      {item.kind === "secret" ? "The lead needs a secret here." : "The lead wants to run a command that needs your approval."}
    </Text>
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

const AUTHOR = { human: "You", lead: "Lead", system: "fleetd" } as const;

const RowView = memo(function RowView(props: {
  row: Row;
  project: ProjectRef;
  /** This is the person's newest message: its receipt shows even once sent. */
  mineLatest: boolean;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  onJumpToLatest: () => void;
  onTold: (lane: AgentLane) => void;
}) {
  const { row: r, project } = props;
  switch (r.kind) {
    case "top":
      return <Top state={r.state} onLoadOlder={props.onLoadOlder} />;
    case "bottom":
      return <Bottom state={r.state} onLoadNewer={props.onLoadNewer} onJumpToLatest={props.onJumpToLatest} />;
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
    case "system":
      return <SystemLine item={r.item} />;
    case "event":
      return (
        <div className={cx(s.quietRow, s.event)} data-entry="event">
          <InlineText size="xs" tone="quiet" text={r.item.text} />
          <span className={s.eventTime}>{shortClock(r.item.at)}</span>
        </div>
      );
    case "inline":
      return (
        <div className={s.message} data-entry="inline">
          <Inline item={r.item} />
        </div>
      );
    case "activity":
      return <LeadActivity project={project} />;
    case "strip":
      return (
        <div className={s.strip}>
          <Boundary part="the live strip">
            <LiveStrip project={project} onTold={props.onTold} />
          </Boundary>
        </div>
      );
    case "message": {
      const i = r.item;
      return (
        <div className={cx(s.message, r.head && s.messageHead, r.history && s.historyMessage)} data-entry="message" data-author={i.author}>
          {r.head ? (
            <div className={s.head}>
              <Text size="xs" strong tone={i.author === "human" ? "accent" : "default"}>
                {AUTHOR[i.author]}
              </Text>
              <Text size="xs" tone="quiet" tabular>
                {shortClock(i.at)}
              </Text>
            </div>
          ) : null}
          {i.text.trim() !== "" ? <Message text={i.text} /> : null}
          {i.attachments.length > 0 ? (
            <div className={s.attachments}>
              {i.attachments.map((a) => (
                <Attachment key={a.attachmentId} project={project} file={a} />
              ))}
            </div>
          ) : null}
          {i.state === "streaming" ? (
            <Text size="xs" tone="quiet">
              Still writing…
            </Text>
          ) : null}
          {i.author === "human" ? (
            <MessageReceipt project={project} item={i} latest={props.mineLatest} />
          ) : null}
        </div>
      );
    }
  }
});

export function ChatList(props: {
  rows: readonly Row[];
  project: ProjectRef;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  onJumpToLatest: () => void;
  onTold: (lane: AgentLane) => void;
  /** A message to open at (a notification's link): scrolled to once it is loaded. */
  openAt?: number | undefined;
  /** Bumped to scroll to `openAt` again (Show, pressed twice). */
  openSeq?: number | undefined;
  /** Bumped when the reader sends: back to the end. */
  sent?: number;
}) {
  const { rows, openAt, openSeq, sent } = props;
  const virtualizer = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const mineLatest = useMemo(() => rows.findLast((r) => r.kind === "message" && r.item.author === "human")?.key, [rows]);

  // Open at the newest row and keep the end in view as rows measure and stream, until the reader scrolls. A link
  // (a notification's, or Show) opens the chat at a message instead, and keeps that message in view the same way:
  // through rows measuring and the window resizing, until the reader scrolls. Keyed by the message, not its index,
  // so older pages loading above it don't pin it again.
  const openKey = openAt === undefined ? undefined : rows[openAt]?.key;
  const openIndex = useRef(openAt);
  useEffect(() => {
    openIndex.current = openAt;
  });
  useEffect(() => {
    const v = virtualizer.current;
    const el = v?.scrollElement;
    const inner = el?.firstElementChild;
    if (!v || !el || !inner) return;
    let pinned = true;
    const release = () => {
      pinned = false;
    };
    const pin = () => {
      if (!pinned) return;
      const at = openIndex.current;
      if (openKey === undefined || at === undefined) el.scrollTop = el.scrollHeight;
      else v.scrollToIndex(at, { align: "center" });
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
            onLoadOlder={props.onLoadOlder}
            onLoadNewer={props.onLoadNewer}
            onJumpToLatest={props.onJumpToLatest}
            onTold={props.onTold}
          />
        )}
      />
    </div>
  );
}
