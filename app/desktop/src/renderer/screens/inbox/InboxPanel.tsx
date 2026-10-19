// The inbox panel's body. F1's shell hosts it over any route (?inbox, ?inbox&ask=<askId>) with its header, close
// button, ⌘I and Esc; this is what is inside: every ask as a question card, the other things that need a look, and
// the reply field.
import { useEffect, useRef, useState } from "react";
import { Button, cx, Input, ScrollArea, StatusChip, Text, Truncate } from "../../ui";
import { needsYou, type AttentionItem } from "./model";
import { QuestionCard } from "./QuestionCard";
import { inboxStore, useInbox } from "./store";
import s from "./InboxPanel.module.css";

export interface InboxPanelProps {
  /** Open on this ask: it is scrolled to and takes the keyboard. */
  askId?: string | undefined;
}

export function InboxPanel({ askId }: InboxPanelProps) {
  const inbox = useInbox();
  const asks = needsYou(inbox);
  const focusId = asks.some((a) => a.askId === askId) ? askId : inbox.open[0]?.askId;
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (askId === undefined) return;
    bodyRef.current?.querySelector(`[data-ask="${CSS.escape(askId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [askId, inbox.loaded]);

  return (
    <div className={s.panel} data-screen="inbox">
      <ScrollArea className={cx(s.scroll)}>
        <div ref={bodyRef} className={s.body}>
          {inbox.loadError === null ? null : (
            <p role="alert" className={s.alert}>
          <Text size="sm" tone="danger">{inbox.loadError}</Text>
        </p>
          )}
          {!inbox.loaded && inbox.loadError === null ? (
            <Text as="p" tone="quiet" className={cx(s.empty)}>
              Loading questions…
            </Text>
          ) : null}
          {inbox.loaded && asks.length === 0 ? (
            <Text as="p" tone="quiet" className={cx(s.empty)}>
              Nothing needs you.
            </Text>
          ) : null}
          {asks.map((ask) => (
            <QuestionCard key={ask.askId} ask={ask} autoFocus={ask.askId === focusId} />
          ))}
          {inbox.attention.length === 0 ? null : <Attention items={inbox.attention} />}
        </div>
      </ScrollArea>
      <ReplyField live={inbox.live} echo={inbox.replyEcho} />
    </div>
  );
}

function Attention({ items }: { items: readonly AttentionItem[] }) {
  return (
    <section className={s.attention} aria-label="Also worth a look">
      <Text size="xs" tone="quiet" strong>
        Also worth a look
      </Text>
      <ul className={s.attentionList}>
        {items.map((item) => (
          <li key={item.seq} className={s.attentionItem}>
            <StatusChip tone={item.urgent ? "failed" : "needs-you"}>{item.urgent ? "Urgent" : "Look"}</StatusChip>
            <span className={s.attentionText}>
              <Text>{item.summary}</Text>
              <span className={s.attentionMeta}>
                {item.project === null ? null : (
                  <Truncate size="xs" tone="quiet">
                    {item.project}
                  </Truncate>
                )}
                <Text size="xs" tone="quiet" tabular>
                  {when(item.at)}
                </Text>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const when = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
};

/** The terse reply, the same grammar as `fleetd answer` and the phone. */
function ReplyField({ live, echo }: { live: boolean; echo: { ok: boolean; text: string } | null }) {
  const [raw, setRaw] = useState("");
  const [sending, setSending] = useState(false);
  const send = (): void => {
    const text = raw.trim();
    if (text === "" || sending || !live) return;
    setSending(true);
    void inboxStore()
      .reply(text)
      .then((ok) => {
        if (ok) setRaw("");
      })
      .finally(() => setSending(false));
  };
  return (
    <footer className={s.reply}>
      <div className={s.replyRow}>
        <Input
          aria-label="Reply"
          className={s.replyInput}
          placeholder={'Reply by number: "1 go", "2: your words", "3 skip"'}
          value={raw}
          disabled={!live}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            } else if (e.key === "Escape" && raw !== "") {
              e.stopPropagation();
              setRaw("");
            }
          }}
        />
        <Button variant="secondary" disabled={!live || sending || raw.trim() === ""} onClick={send}>
          Send
        </Button>
      </div>
      {echo === null ? null : (
        <p aria-live="polite" className={s.echo}>
          <Text size="xs" tone={echo.ok ? "quiet" : "danger"}>
            {echo.text}
          </Text>
        </p>
      )}
    </footer>
  );
}
