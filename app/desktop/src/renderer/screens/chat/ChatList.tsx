// The lead chat as a virtualized list: only the rows on screen render, each measured to its wrapped height. It
// opens at the newest message and stays there as rows measure and new ones stream in, until the reader scrolls
// (the follow rule is T3 Code's: apps/web MessagesTimeline.logic.ts). Scrolling to the top loads older pages; the
// list keeps its place while they arrive above.
import type { Virtualizer } from "@tanstack/react-virtual";
import { FileText, Image } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { projectKey } from "../../src/data/store";
import type { AgentLane } from "../../../shared/contracts";
import { Button, cx, Text, Truncate, VirtualList } from "../../ui";
import type { ChatItem } from "../../src/data/chat";

type ChatAttachment = ChatItem["attachments"][number];
import { shortClock } from "./format";
import { systemHeadline, type Row } from "./model";
import { MessageReceipt } from "./Composer";
import { LiveStrip } from "../live";
import { InlineChatItem, type ProjectRef } from "./slots";
import { Disclosure, InlineText, Message } from "./text";
import s from "./view.module.css";

const sizeWords = (n: number): string => (n < 1024 ? `${String(n)} B` : n < 1024 * 1024 ? `${String(Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function Attachment({ a }: { a: ChatAttachment }) {
  const Icon = a.mime.startsWith("image/") ? Image : FileText;
  const size = a.bytes === undefined ? undefined : sizeWords(a.bytes);
  return (
    <span className={s.attachment} title={size ? `${a.name} · ${size}` : a.name}>
      <Icon className={s.attachmentIcon} aria-hidden />
      <Truncate as="code" size="xs" mono>
        {a.name}
      </Truncate>
      {size ? (
        <Text size="xs" tone="quiet" className={cx(s.flexNone)}>
          {size}
        </Text>
      ) : null}
    </span>
  );
}

function Top({ state, onLoadOlder }: { state: "more" | "loading" | "start"; onLoadOlder: () => void }) {
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
      ) : (
        <Text size="xs" tone="quiet">
          This is the start of the conversation.
        </Text>
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

const AUTHOR = { human: "You", lead: "Lead", system: "fleetd" } as const;

const RowView = memo(function RowView(props: {
  row: Row;
  project: ProjectRef;
  /** This is the person's newest message: its receipt shows even once sent. */
  mineLatest: boolean;
  onLoadOlder: () => void;
  onTold: (lane: AgentLane) => void;
}) {
  const { row: r, project } = props;
  switch (r.kind) {
    case "top":
      return <Top state={r.state} onLoadOlder={props.onLoadOlder} />;
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
          <InlineChatItem item={r.item} project={project} />
        </div>
      );
    case "strip":
      return (
        <div className={s.strip}>
          <LiveStrip project={project} onTold={props.onTold} />
        </div>
      );
    case "message": {
      const i = r.item;
      return (
        <div className={cx(s.message, r.head && s.messageHead, i.author === "human" && s.mine)} data-entry="message" data-author={i.author}>
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
                <Attachment key={a.attachmentId} a={a} />
              ))}
            </div>
          ) : null}
          {i.state === "streaming" ? (
            <Text size="xs" tone="quiet">
              Still writing…
            </Text>
          ) : null}
          {i.author === "human" ? (
            <MessageReceipt
              projectKey={projectKey(project)}
              clientRequestId={i.clientRequestId}
              text={i.text}
              message={{ state: i.state, error: i.error ? { ...i.error, offline: i.offline === true } : undefined }}
              latest={props.mineLatest}
            />
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
  onTold: (lane: AgentLane) => void;
  /** A message to open at (a notification's link): scrolled to once it is loaded. */
  openAt?: number | undefined;
  /** Bumped when the reader sends: back to the end. */
  sent?: number;
}) {
  const { rows, openAt, sent } = props;
  const virtualizer = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  const mineLatest = useMemo(() => rows.findLast((r) => r.kind === "message" && r.item.author === "human")?.key, [rows]);

  // Open at the newest row and keep the end in view as rows measure and stream, until the reader scrolls or a
  // link opens the chat at a message.
  const jumping = openAt !== undefined;
  useEffect(() => {
    const el = virtualizer.current?.scrollElement;
    const inner = el?.firstElementChild;
    if (jumping || !el || !inner) return;
    let pinned = true;
    const release = () => {
      pinned = false;
    };
    const pin = () => {
      if (pinned) el.scrollTop = el.scrollHeight;
    };
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
  }, [jumping]);

  useEffect(() => {
    if (openAt !== undefined) virtualizer.current?.scrollToIndex(openAt, { align: "center" });
  }, [openAt]);

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
        virtualizerRef={virtualizer}
        aria-label="Conversation with the lead"
        renderItem={(r) => (
          <RowView row={r} project={props.project} mineLatest={r.key === mineLatest} onLoadOlder={props.onLoadOlder} onTold={props.onTold} />
        )}
      />
    </div>
  );
}
