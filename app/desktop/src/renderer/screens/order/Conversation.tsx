// The lead's conversation as a virtualized log: only the rows on screen render, each measured to its wrapped
// height, pinned to the end while new rows and the streaming message arrive unless the reader scrolled up (the
// follow rule is T3 Code's: re-arm within a small distance of the end, apps/web MessagesTimeline.logic.ts).

import type { Virtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx, IdChip, InlineCode, Markdown, Text, Tooltip, VirtualList, type TextProps } from "../../ui";
import { foldLabel, jumpTarget, systemHeadline, type Author, type Call, type Entry } from "./conversationModel";
import { clock, codeRuns, machineCode } from "./format";
import type { Receipt, ReceiptAct } from "./receipts";
import s from "./order.module.css";

export interface ReceiptHandlers {
  readonly onAct: (act: ReceiptAct) => void;
}

/** A message in markdown, with its machine tokens set as code; parsed once per text. */
export function Message({ text }: { text: string }) {
  const source = useMemo(() => machineCode(text), [text]);
  return <Markdown source={source} />;
}

/** One line of words with its `code` runs set as code (receipts, criteria, reasons): no block markdown. */
export function InlineText(props: { text: string } & Omit<TextProps, "children">) {
  const { text, ...style } = props;
  const runs = useMemo(() => codeRuns(machineCode(text)), [text]);
  return (
    <Text {...style}>
      {runs.map((r, i) => (r.code ? <InlineCode key={i}>{r.text}</InlineCode> : r.text))}
    </Text>
  );
}

export function ReceiptLine({ receipt, onAct }: { receipt: Receipt } & ReceiptHandlers) {
  const act = receipt.act;
  return (
    <div className={cx(s.receipt, s[`tone-${receipt.tone}`])} data-receipt={receipt.stage}>
      <InlineText size="xs" tone="inherit" text={receipt.line} />
      {receipt.detail ? <IdChip label="Details" id={receipt.detail} kind="error" size="xs" tone="quiet" /> : null}
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
          <Message text={text} />
        </div>
      ) : null}
    </div>
  );
}

type Lit = { readonly key: string; readonly call?: number | undefined };

/** A merged events line: a train run makes a long one, so it shows three lines with "Show all". */
function EventsLine({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > 280;
  return (
    <div className={s.body}>
      <div className={cx(long && !all && s.clamp3)}>
        <InlineText size="xs" tone="quiet" text={text} />
      </div>
      {long ? (
        <button type="button" className={s.linkButton} onClick={() => setAll((a) => !a)}>
          <Text size="xs" tone="inherit">
            {all ? "Show less" : "Show all"}
          </Text>
        </button>
      ) : null}
    </div>
  );
}

const Row = memo(function Row(
  props: { entry: Entry; open: boolean; last: boolean; lit: Lit | undefined; onToggle: (key: string) => void } & ReceiptHandlers,
) {
  const { entry: e, open, onToggle, onAct } = props;
  const toggle = () => onToggle(e.key);
  // A lit call lights alone; otherwise the whole row does.
  const litCall = props.lit?.call;
  const last = cx(props.last && s.rowLast, props.lit !== undefined && litCall === undefined && s.lit);
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
            <Message text={e.text} />
            {e.streaming ? <span className={s.streaming}>Still writing…</span> : null}
            {e.clipped ? <span className={s.streaming}>The hub sends 2,000 characters of a long message; the whole of it is in the thread.</span> : null}
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
                <Message text={e.text} />
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
          {open ? <Calls calls={e.calls} lit={litCall} /> : null}
        </div>
      );
    case "working":
      return (
        <div className={cx(s.indented, last)} data-entry="working">
          <Calls calls={e.calls} lit={litCall} />
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
          <EventsLine text={e.text} />
        </div>
      );
    case "more":
      return (
        <div className={cx(s.row, s.rowMore, last)} data-entry="more">
          <span />
          <span />
          <div className={s.body}>
            <Message text={e.text} />
            {e.streaming ? <span className={s.streaming}>Still writing…</span> : null}
            {e.clipped ? <span className={s.streaming}>The hub sends 2,000 characters of a long message; the whole of it is in the thread.</span> : null}
            {e.receipt ? <ReceiptLine receipt={e.receipt} onAct={onAct} /> : null}
          </div>
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

function Calls({ calls, lit }: { calls: readonly Call[]; lit?: number | undefined }) {
  return (
    <div className={s.calls}>
      {calls.map((c, i) => (
        <Text key={i} mono className={cx(s.call, c.failed && s.callFailed, i === lit && s.lit)}>
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
    /** A transcript jump: scroll to the row holding the item at `at`, open it if it is a fold, light it briefly. */
    focus?: { readonly index: number; readonly at: string } | undefined;
  } & ReceiptHandlers,
) {
  const { entries, onAct, focus } = props;
  const [lit, setLit] = useState<Lit | undefined>(undefined);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const onToggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const virtualizer = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);

  const target = focus === undefined ? undefined : entries[focus.index];
  const focusKey = target === undefined || focus === undefined ? undefined : `${target.key}@${focus.at}`;
  useEffect(() => {
    const v = virtualizer.current;
    if (focus === undefined || target === undefined || !v) return;
    const jump = jumpTarget(target, focus.at);
    const frame = requestAnimationFrame(() => {
      if (jump.open) setOpen((prev) => new Set([...prev, target.key]));
      v.scrollToIndex(focus.index, { align: "center" });
      setLit({ key: target.key, call: jump.call });
    });
    const done = window.setTimeout(() => setLit(undefined), 1600);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(done);
    };
    // Once per jump target, not on every new row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  // Open at the newest row. The list starts at the end on its row-height guesses; tall markdown rows then measure
  // taller and push the end below the fold. Until the reader scrolls (or a jump takes over), keep the end in view as
  // the rows settle.
  const listShown = entries.length > 0 || props.notice === undefined;
  const jumping = focus !== undefined;
  useEffect(() => {
    const el = virtualizer.current?.scrollElement;
    const inner = el?.firstElementChild;
    if (!listShown || jumping || !el || !inner) return;
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
  }, [listShown, jumping]);

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
          <Row entry={e} open={open.has(e.key)} last={i === entries.length - 1} lit={lit?.key === e.key ? lit : undefined} onToggle={onToggle} onAct={onAct} />
        )}
      />
    </div>
  );
}
