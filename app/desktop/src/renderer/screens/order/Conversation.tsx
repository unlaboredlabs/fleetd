// The lead's conversation as a virtualized log: only the rows on screen render, each measured to its wrapped
// height, pinned to the end while new rows and the streaming message arrive unless the reader scrolled up (the
// follow rule is T3 Code's: re-arm within a small distance of the end, apps/web MessagesTimeline.logic.ts).

import type { Virtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { cx, Markdown, Text, Tooltip, VirtualList } from "../../ui";
import { foldLabel, systemHeadline, type Author, type Call, type Entry } from "./conversation";
import { clock } from "./format";
import type { Receipt, ReceiptAct } from "./receipts";
import s from "./order.module.css";

export interface ReceiptHandlers {
  readonly onAct: (act: ReceiptAct) => void;
}

export function ReceiptLine({ receipt, onAct }: { receipt: Receipt } & ReceiptHandlers) {
  const act = receipt.act;
  return (
    <div className={cx(s.receipt, s[`tone-${receipt.tone}`])} data-receipt={receipt.stage}>
      <Text size="xs" tone="inherit">
        {receipt.line}
      </Text>
      {act ? (
        <button type="button" className={s.linkButton} onClick={() => onAct(act)}>
          {act.kind === "withdraw" ? "Withdraw" : "Interrupt and redirect"}
        </button>
      ) : null}
    </div>
  );
}

const authorWord = (a: Author): string => (a.kind === "lead" ? "Lead" : "You");

function Disclosure(props: { open: boolean; onToggle: () => void; children: string }) {
  const Icon = props.open ? ChevronDown : ChevronRight;
  return (
    <button type="button" className={s.disclosure} aria-expanded={props.open} onClick={props.onToggle}>
      <Icon className={s.chevron} aria-hidden />
      <Text size="xs" tone="inherit">
        {props.children}
      </Text>
    </button>
  );
}

/** fleetd's own text to an agent (its brief, a wake, a nudge): one muted line, expandable to the rendered text. */
export function FleetdText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={s.body}>
      <Disclosure open={open} onToggle={() => setOpen((o) => !o)}>
        {systemHeadline(text)}
      </Disclosure>
      {open ? (
        <div className={s.systemText}>
          <Markdown source={text} />
        </div>
      ) : null}
    </div>
  );
}

const Row = memo(function Row(props: { entry: Entry; open: boolean; last: boolean; lit: boolean; onToggle: (key: string) => void } & ReceiptHandlers) {
  const { entry: e, open, onToggle, onAct } = props;
  const toggle = () => onToggle(e.key);
  const last = cx(props.last && s.rowLast, props.lit && s.lit);
  switch (e.kind) {
    case "say":
      return (
        <div className={cx(s.row, last)} data-entry="say">
          <span className={s.time}>{e.at ? clock(e.at) : ""}</span>
          <span className={cx(s.author, e.author.kind === "you" && s.authorYou)}>
            {e.author.kind === "you" && e.author.keyName ? (
              <Tooltip content={`Sent from ${e.author.keyName}`}>
                <span tabIndex={0}>{authorWord(e.author)}</span>
              </Tooltip>
            ) : (
              authorWord(e.author)
            )}
          </span>
          <div className={s.body}>
            {e.to ? <span className={s.to}>to {e.to}, directly</span> : null}
            <Markdown source={e.text} />
            {e.streaming ? <span className={s.streaming}>Still writing…</span> : null}
            {e.clipped ? <span className={s.streaming}>The hub sends a message’s first 2,000 characters; the rest is in the thread.</span> : null}
            {e.receipt ? <ReceiptLine receipt={e.receipt} onAct={onAct} /> : null}
          </div>
        </div>
      );
    case "system":
      return (
        <div className={cx(s.row, last)} data-entry="system">
          <span className={s.time}>{clock(e.at)}</span>
          <span className={s.author}>fleetd</span>
          <div className={s.body}>
            <Disclosure open={open} onToggle={toggle}>
              {e.headline}
            </Disclosure>
            {open ? (
              <div className={s.systemText}>
                <Markdown source={e.text} />
              </div>
            ) : null}
          </div>
        </div>
      );
    case "fold":
      return (
        <div className={cx(s.indented, last)} data-entry="fold">
          <Disclosure open={open} onToggle={toggle}>
            {foldLabel(e.secs, e.commands, e.failed, e.calls.length)}
          </Disclosure>
          {open ? <Calls calls={e.calls} /> : null}
        </div>
      );
    case "working":
      return (
        <div className={cx(s.indented, last)} data-entry="working">
          <Calls calls={e.calls} />
        </div>
      );
    case "others":
      return (
        <div className={cx(s.indented, last)} data-entry="others">
          <Text size="xs" tone="quiet">
            {`${e.n} ${e.n === 1 ? "message" : "messages"} about ${e.about}`}
          </Text>
        </div>
      );
    case "events":
      return (
        <div className={cx(s.row, last)} data-entry="events">
          <span className={s.time}>{clock(e.at)}</span>
          <span />
          <Text size="xs" tone="quiet">
            {e.text}
          </Text>
        </div>
      );
    case "rollup":
      return (
        <div className={cx(s.indented, last)} data-entry="rollup">
          <Text size="xs" tone="quiet" strong>
            {e.text}
          </Text>
        </div>
      );
  }
});

function Calls({ calls }: { calls: readonly Call[] }) {
  return (
    <div className={s.calls}>
      {calls.map((c, i) => (
        <Text key={i} mono className={cx(s.call, c.failed && s.callFailed)}>
          {c.summary}
        </Text>
      ))}
    </div>
  );
}

export function Conversation(
  props: {
    entries: readonly Entry[];
    notice?: { text: string; error: boolean };
    /** Scroll to this row and light it briefly (a transcript jump). */
    focus?: number | undefined;
  } & ReceiptHandlers,
) {
  const { entries, onAct, focus } = props;
  const [lit, setLit] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const onToggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const virtualizer = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);

  // The streaming message grows in place; VirtualList follows new rows, this follows the growth.
  const lastEntry = entries.at(-1);
  const growing = lastEntry?.kind === "say" && lastEntry.streaming ? lastEntry.text.length : 0;
  useEffect(() => {
    const v = virtualizer.current;
    const el = v?.scrollElement;
    if (!v || !el || growing === 0) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 80) return;
    const frame = requestAnimationFrame(() => v.scrollToIndex(entries.length - 1, { align: "end" }));
    return () => cancelAnimationFrame(frame);
  }, [growing, entries.length]);

  const focusKey = focus === undefined ? undefined : entries[focus]?.key;
  useEffect(() => {
    const v = virtualizer.current;
    if (focus === undefined || focusKey === undefined || !v) return;
    const frame = requestAnimationFrame(() => {
      v.scrollToIndex(focus, { align: "center" });
      setLit(focusKey);
    });
    const done = window.setTimeout(() => setLit(undefined), 1600);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(done);
    };
    // Once per jump target, not on every new row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  if (entries.length === 0 && props.notice) {
    return (
      <div className={s.logEmpty} data-screen="order.log-empty">
        <Text tone={props.notice.error ? "danger" : "quiet"}>{props.notice.text}</Text>
      </div>
    );
  }
  return (
    <div className={s.log}>
      <VirtualList
        items={entries}
        getKey={(e) => e.key}
        estimateSize={44}
        followOutput
        startAtEnd
        virtualizerRef={virtualizer}
        aria-label="The lead’s conversation"
        renderItem={(e, i) => (
          <Row entry={e} open={open.has(e.key)} last={i === entries.length - 1} lit={lit === e.key} onToggle={onToggle} onAct={onAct} />
        )}
      />
    </div>
  );
}
