// The command palette (⌘K): one field that reaches every command, order, project, machine, settings page and
// prompt, and that also takes a terse inbox reply ("1 go 2 nvm 3 b"). Up/Down or the mouse pick, Enter or a click
// runs, Esc or a click outside closes. Typed text nothing matches can become a new order (the last row).

import { Dialog as D } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { display, isShortcutId } from "../../../shared/shortcuts";
import { Kbd, Text } from "../../ui";
import { rank } from "./rank";
import { GROUP_LABELS, currentTextAction, snapshotItems, subscribeRegistry, subscribeSources, type Command } from "./registry";
import { isReply, namedItems, readReplyOutcome, type ReplyResult } from "./reply";
import { closeOverlay, noteRecent, readRecent } from "./state";
import s from "./Palette.module.css";

type Row =
  | { readonly kind: "item"; readonly item: Command; readonly label: string | undefined }
  | { readonly kind: "text"; readonly title: string; readonly text: string };

const useItems = (): Command[] => {
  const [items, setItems] = useState(snapshotItems);
  useEffect(() => {
    const refresh = () => setItems(snapshotItems());
    const offRegistry = subscribeRegistry(refresh);
    const offSources = subscribeSources(refresh);
    return () => {
      offRegistry();
      offSources();
    };
  }, []);
  return items;
};

const buildRows = (query: string, items: readonly Command[], recent: readonly string[]): Row[] => {
  const ranked = rank(query, items, recent);
  const rows: Row[] = ranked.recent.map((item, i) => ({ kind: "item", item, label: i === 0 ? "Recent" : undefined }));
  let group: string | undefined;
  for (const item of ranked.matches) {
    const label = GROUP_LABELS[item.group];
    rows.push({ kind: "item", item, label: label === group ? undefined : label });
    group = label;
  }
  const text = query.trim();
  const action = currentTextAction();
  if (text !== "" && action) rows.push({ kind: "text", title: action.title(text), text });
  return rows;
};

export function Palette({ initialQuery }: { initialQuery: string }) {
  const platform = window.fleetd.platform;
  const listId = useId();
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);
  const [reply, setReply] = useState<{ readonly sending: boolean; readonly result?: ReplyResult }>({ sending: false });
  const [recent] = useState(readRecent);
  const items = useItems();
  const listRef = useRef<HTMLDivElement>(null);

  const replying = isReply(query);
  const rows = useMemo(() => (replying ? [] : buildRows(query, items, recent)), [replying, query, items, recent]);
  const current = Math.min(selected, Math.max(0, rows.length - 1));
  const rowId = (i: number) => `${listId}-${i}`;

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const run = (row: Row | undefined) => {
    if (!row) return;
    closeOverlay();
    if (row.kind === "text") {
      currentTextAction()?.run(row.text);
      return;
    }
    noteRecent(row.item.id);
    row.item.run();
  };

  const sendReply = async () => {
    const raw = query.trim();
    if (raw === "" || reply.sending) return;
    setReply({ sending: true });
    const result = readReplyOutcome(await window.fleetd.hub.call("inbox_reply", { raw }));
    setReply({ sending: false, result });
    // Answered: clear the field for the next one. Not read: keep the text so it can be fixed.
    if (result.ok) setQuery("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    const step = event.key === "ArrowDown" || (ctrlOnly && event.key === "n") ? 1 : event.key === "ArrowUp" || (ctrlOnly && event.key === "p") ? -1 : 0;
    if (step !== 0) {
      event.preventDefault();
      if (rows.length > 0) setSelected((current + step + rows.length) % rows.length);
      return;
    }
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (replying) void sendReply();
      else run(rows[current]);
    }
  };

  const asks = useMemo(() => {
    if (!replying) return [];
    const byNumber = new Map(items.flatMap((item) => (item.askNumber === undefined ? [] : [[item.askNumber, item] as const])));
    return namedItems(query).map((n) => ({ n, item: byNumber.get(n) }));
  }, [replying, query, items]);

  return (
    <D.Root open onOpenChange={(open) => !open && closeOverlay()}>
      <D.Portal>
        <D.Overlay className={s.backdrop} />
        <D.Content className={s.palette} data-screen={replying ? "palette.reply" : "palette"} aria-describedby={undefined}>
          {/* Names the dialog for screen readers (aria-labelledby reads hidden text); hidden, not clipped, so it takes no box. */}
          <D.Title hidden>Command palette</D.Title>
          <div className={s.field}>
            {replying ? <span className={s.mode}>Reply</span> : null}
            <input
              className={s.input}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
                if (!reply.sending) setReply({ sending: false });
              }}
              onKeyDown={onKeyDown}
              placeholder="Search orders, projects and settings, or reply: 1 go 2 nvm"
              aria-label="Search or reply"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={!replying && rows.length > 0 ? rowId(current) : undefined}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              maxLength={4000}
            />
          </div>

          {replying || reply.result ? (
            <div className={s.reply} role="status">
              {replying && asks.length > 0 ? (
                <ol className={s.asks}>
                  {asks.map(({ n, item }) => (
                    <li key={n} className={s.ask}>
                      <span className={s.askNumber}>{n}</span>
                      <Text tone={item ? "default" : "quiet"}>{item ? item.title : "Not an open question right now"}</Text>
                    </li>
                  ))}
                </ol>
              ) : null}
              {reply.result ? (
                <Text as="p" tone={reply.result.ok ? "success" : "danger"}>
                  {reply.result.text}
                </Text>
              ) : null}
              {replying ? (
                <Text as="p" size="sm" tone="quiet">
                  {reply.sending ? "Sending…" : "Enter sends it to the inbox. go or yes takes the recommendation, nvm or no drops it, a letter picks an option, “2: text” answers in your words."}
                </Text>
              ) : null}
            </div>
          ) : null}

          {replying ? null : (
            <div className={s.list} id={listId} role="listbox" aria-label="Results" ref={listRef}>
              {rows.length === 0 ? (
                <div className={s.empty}>
                  <Text tone="quiet">Nothing matches.</Text>
                </div>
              ) : (
                rows.map((row, i) => {
                  const keys = row.kind === "item" && isShortcutId(row.item.id) ? display(row.item.id, platform) : undefined;
                  return (
                    <div key={row.kind === "item" ? row.item.id : "text-action"} className={s.section}>
                      {row.kind === "item" && row.label !== undefined ? (
                        <div className={s.groupLabel} role="presentation">
                          {row.label}
                        </div>
                      ) : null}
                      <div
                        id={rowId(i)}
                        data-index={i}
                        role="option"
                        aria-selected={i === current}
                        className={s.row}
                        onMouseMove={() => i !== current && setSelected(i)}
                        onClick={() => run(row)}
                      >
                        <div className={s.rowText}>
                          <Text strong={row.kind === "item" && row.item.group === "needs-you"}>{row.kind === "item" ? row.item.title : row.title}</Text>
                          {row.kind === "item" && row.item.detail ? (
                            <Text size="sm" tone="quiet">
                              {row.item.detail}
                            </Text>
                          ) : null}
                        </div>
                        {keys !== undefined ? <Kbd>{keys}</Kbd> : row.kind === "text" ? <Kbd>Enter</Kbd> : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          <div className={s.footer}>
            <Text size="xs" tone="quiet">
              {replying ? "Esc closes" : "↑↓ move · Enter runs · Esc closes"}
            </Text>
            <Text size="xs" tone="quiet">
              {`All shortcuts ${display("shortcuts.show", platform)}`}
            </Text>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
