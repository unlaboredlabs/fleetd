// The command palette (⌘K): one field that reaches every project's lead chat, every command, machine, settings
// page and prompt. Up/Down or the mouse pick, Enter or a click runs, Esc or a click outside closes.

import { Dialog as D } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { display, isShortcutId } from "../../../shared/shortcuts";
import { Kbd, Text } from "../../ui";
import { rank } from "./rank";
import { GROUP_LABELS, snapshotItems, subscribeRegistry, subscribeSources, type Command } from "./registry";
import { useReturnFocus } from "./focus";
import { closeOverlay, noteRecent, readRecent } from "./state";
import s from "./Palette.module.css";

/** `label` starts a group. */
interface Row {
  readonly item: Command;
  readonly label: string | undefined;
}

const useItems = (): Command[] => {
  const [items, setItems] = useState(snapshotItems);
  useEffect(() => {
    const refresh = () => setItems(snapshotItems());
    let offSources = subscribeSources(refresh);
    // A source registered while the palette is open (a screen mounting) is followed too.
    const offRegistry = subscribeRegistry(() => {
      offSources();
      offSources = subscribeSources(refresh);
      refresh();
    });
    return () => {
      offRegistry();
      offSources();
    };
  }, []);
  return items;
};

const buildRows = (query: string, items: readonly Command[], recent: readonly string[]): Row[] => {
  const ranked = rank(query, items, recent);
  const rows: Row[] = ranked.recent.map((item, i) => ({ item, label: i === 0 ? "Recent" : undefined }));
  let group: string | undefined;
  for (const item of ranked.matches) {
    const label = GROUP_LABELS[item.group];
    rows.push({ item, label: label === group ? undefined : label });
    group = label;
  }
  return rows;
};

export function Palette({ initialQuery }: { initialQuery: string }) {
  const platform = window.fleetd.platform;
  const listId = useId();
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);
  const [recent] = useState(readRecent);
  const items = useItems();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // A command that ran may have moved focus on purpose (⌘L to the composer); only a plain close returns it.
  const ranRef = useRef(false);
  const returnFocus = useReturnFocus(() => ranRef.current);

  const rows = useMemo(() => buildRows(query, items, recent), [query, items, recent]);
  const current = Math.min(selected, Math.max(0, rows.length - 1));
  const rowId = (i: number) => `${listId}-${i}`;

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const run = (row: Row | undefined) => {
    if (!row) return;
    ranRef.current = true;
    closeOverlay();
    noteRecent(row.item.id);
    row.item.run();
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
      run(rows[current]);
    }
  };

  return (
    <D.Root open onOpenChange={(open) => !open && closeOverlay()}>
      <D.Portal>
        <D.Overlay className={s.backdrop} />
        {/* Named by aria-label, not a visually hidden title, until the QA overflow check exempts sr-only text (E3). */}
        <D.Content
          className={s.palette}
          data-screen={query.trim() === "" ? "palette" : "palette.search"}
          aria-label="Command palette"
          aria-labelledby={undefined}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            // Not autoFocus: Radix must record the element focused before the palette, to return focus to it.
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={returnFocus}
        >
          <div className={s.field}>
            <input
              ref={inputRef}
              className={s.input}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Go to a project, Status, Time or Settings"
              aria-label="Search"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={rows.length > 0 ? rowId(current) : undefined}
              spellCheck={false}
              autoComplete="off"
              maxLength={200}
            />
          </div>

          <div className={s.list} id={listId} role="listbox" aria-label="Results" ref={listRef}>
              {rows.length === 0 ? (
                <div className={s.empty}>
                  <Text tone="quiet">Nothing matches.</Text>
                </div>
              ) : (
                rows.map((row, i) => {
                  const keys = isShortcutId(row.item.id) ? display(row.item.id, platform) : undefined;
                  return (
                    <div key={row.item.id} className={s.section}>
                      {row.label !== undefined ? (
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
                          <Text>{row.item.title}</Text>
                          {row.item.detail ? (
                            <Text size="sm" tone="quiet">
                              {row.item.detail}
                            </Text>
                          ) : null}
                        </div>
                        {keys !== undefined ? <Kbd>{keys}</Kbd> : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

          <div className={s.footer}>
            <Text size="xs" tone="quiet">
              ↑↓ move · Enter runs · Esc closes
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
