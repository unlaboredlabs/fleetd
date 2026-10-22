// The command palette (⌘K): one field that reaches every project's lead chat, every command, machine, setting and
// prompt. Up/Down or the mouse pick, Enter or a click runs, ⌘K lists the selected item's other actions, Esc steps
// back out of them or closes.

import { Dialog as D } from "radix-ui";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { display, isShortcutId, shortcutFor } from "../../../shared/shortcuts";
import { Button, Kbd, Text, Truncate } from "../../ui";
import { match, rank, type Frecency } from "./rank";
import { GROUP_LABELS, snapshotItems, subscribeRegistry, subscribeSources, type Action, type Command } from "./registry";
import { useReturnFocus } from "./focus";
import { currentProjectItem } from "./projects";
import { closeOverlay, noteRun, openShortcuts, readFrecency } from "./state";
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

export const buildRows = (query: string, items: readonly Command[], frecency: Frecency): Row[] => {
  const ranked = rank(query, items, frecency);
  const rows: Row[] = ranked.suggested.map((item, i) => ({ item, label: i === 0 ? "Suggestions" : undefined }));
  let group: string | undefined;
  for (const item of ranked.matches) {
    const label = GROUP_LABELS[item.group];
    rows.push({ item, label: label === group ? undefined : label });
    group = label;
  }
  return rows;
};

/** The letters `query` matched in `text`, marked; plain text when the match is too scattered to have found it. */
const Highlighted = ({ text, query }: { text: string; query: string }): ReactNode => {
  const letters = Array.from(query).filter((c) => !/\s/u.test(c)).length;
  const m = letters === 0 ? undefined : match(query, text);
  if (m === undefined || m.score < 2 * letters) return text;
  const hits = new Set(m.at);
  const runs: { text: string; hit: boolean }[] = [];
  Array.from(text).forEach((c, i) => {
    const hit = hits.has(i);
    const last = runs.at(-1);
    if (last?.hit === hit) runs[runs.length - 1] = { text: last.text + c, hit };
    else runs.push({ text: c, hit });
  });
  return runs.map((run, i) => (run.hit ? <mark key={i} className={s.hit}>{run.text}</mark> : <Fragment key={i}>{run.text}</Fragment>));
};

const rankActions = (query: string, actions: readonly Action[]): Action[] => {
  const q = query.trim();
  if (q === "") return [...actions];
  return actions
    .map((action) => ({ action, score: match(q, action.title)?.score }))
    .filter((a): a is { action: Action; score: number } => a.score !== undefined && a.score >= 2 * Array.from(q.replace(/\s/gu, "")).length)
    .sort((a, b) => b.score - a.score)
    .map((a) => a.action);
};

export function Palette({ initialQuery }: { initialQuery: string }) {
  const platform = window.fleetd.platform;
  const listId = useId();
  const [query, setQuery] = useState(initialQuery);
  const [frecency] = useState(() => readFrecency());
  const items = useItems();
  const rows = useMemo(() => buildRows(query, items, frecency), [query, items, frecency]);
  // Opens on the project you're in, so Enter stays put and ⌘K acts on it; until the user moves, the selection
  // follows that project as rows arrive.
  const [selected, setSelected] = useState<number | string>(() => (initialQuery === "" ? (currentProjectItem(window.location.hash) ?? 0) : 0));
  const at = typeof selected === "number" ? selected : Math.max(0, rows.findIndex((r) => r.item.id === selected));
  const current = Math.min(at, Math.max(0, rows.length - 1));
  const chosen = rows[current]?.item;
  // The item whose actions are listed (⌘K), with their own filter and selection.
  const [actionsOf, setActionsOf] = useState<Command | null>(null);
  const [actionQuery, setActionQuery] = useState("");
  const [actionAt, setActionAt] = useState(0);
  const actions = useMemo(() => (actionsOf === null ? [] : rankActions(actionQuery, actionsOf.actions ?? [])), [actionsOf, actionQuery]);
  const actionCurrent = Math.min(actionAt, Math.max(0, actions.length - 1));

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // A command that ran may have moved focus on purpose (⌘L to the composer); only a plain close returns it.
  const ranRef = useRef(false);
  const returnFocus = useReturnFocus(() => ranRef.current);
  const rowId = (i: number) => `${listId}-${i}`;
  const shown = actionsOf === null ? current : actionCurrent;

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${shown}"]`)?.scrollIntoView({ block: "nearest" });
  }, [shown, actionsOf]);

  const finish = (id: string, run: () => void) => {
    ranRef.current = true;
    closeOverlay();
    noteRun(id);
    run();
  };

  const openActions = (item: Command | undefined) => {
    if (item?.actions === undefined || item.actions.length === 0) return false;
    setActionsOf(item);
    setActionQuery("");
    setActionAt(0);
    inputRef.current?.focus();
    return true;
  };

  const closeActions = () => {
    setActionsOf(null);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    // ⌘K inside the palette lists the selected item's actions (the keymap leaves it to us while we're open).
    if (shortcutFor(event, platform) === "palette.toggle") {
      event.preventDefault();
      if (actionsOf !== null) closeActions();
      else if (!openActions(chosen)) closeOverlay();
      return;
    }
    // The rest are the field's keys; a focused footer button keeps its own Enter.
    if (event.target !== inputRef.current) return;
    if (actionsOf !== null && event.key === "Backspace" && actionQuery === "") {
      event.preventDefault();
      closeActions();
      return;
    }
    const count = actionsOf === null ? rows.length : actions.length;
    const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    const step = event.key === "ArrowDown" || (ctrlOnly && event.key === "n") ? 1 : event.key === "ArrowUp" || (ctrlOnly && event.key === "p") ? -1 : 0;
    if (step !== 0) {
      event.preventDefault();
      if (count === 0) return;
      if (actionsOf === null) setSelected((current + step + count) % count);
      else setActionAt((actionCurrent + step + count) % count);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (actionsOf === null) {
        if (chosen !== undefined) finish(chosen.id, chosen.run);
      } else {
        const action = actions[actionCurrent];
        if (action !== undefined) finish(actionsOf.id, action.run);
      }
    }
  };

  const hasActions = (chosen?.actions?.length ?? 0) > 0;
  const kbdK = display("palette.toggle", platform);

  return (
    <D.Root open onOpenChange={(open) => !open && closeOverlay()}>
      <D.Portal>
        <D.Overlay className={s.backdrop} />
        {/* Named by aria-label, not a visually hidden title, until the QA overflow check exempts sr-only text (E3). */}
        <D.Content
          className={s.palette}
          data-screen={actionsOf !== null ? "palette.actions" : query.trim() === "" ? "palette" : "palette.search"}
          aria-label="Command palette"
          aria-labelledby={undefined}
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(event) => {
            // Not autoFocus: Radix must record the element focused before the palette, to return focus to it.
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (actionsOf === null) return;
            event.preventDefault();
            closeActions();
          }}
          onCloseAutoFocus={returnFocus}
        >
          <div className={s.field}>
            <input
              ref={inputRef}
              className={s.input}
              value={actionsOf === null ? query : actionQuery}
              onChange={(event) => {
                if (actionsOf === null) {
                  setQuery(event.target.value);
                  setSelected(0);
                } else {
                  setActionQuery(event.target.value);
                  setActionAt(0);
                }
              }}
              placeholder={actionsOf === null ? "Go to a project, a setting, Status or Time" : "Search actions"}
              aria-label="Search"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={(actionsOf === null ? rows.length : actions.length) > 0 ? rowId(shown) : undefined}
              spellCheck={false}
              autoComplete="off"
              maxLength={200}
            />
          </div>

          <div className={s.list} id={listId} role="listbox" aria-label={actionsOf === null ? "Results" : `Actions for ${actionsOf.title}`} ref={listRef}>
            {actionsOf !== null ? (
              <>
                <div className={s.groupLabel} role="presentation">
                  <Truncate expand="none" size="xs" tone="quiet">
                    {actionsOf.title}
                  </Truncate>
                </div>
                {actions.length === 0 ? (
                  <div className={s.empty}>
                    <Text tone="quiet">No action matches.</Text>
                  </div>
                ) : (
                  actions.map((action, i) => (
                    <div
                      key={action.title}
                      id={rowId(i)}
                      data-index={i}
                      role="option"
                      aria-selected={i === actionCurrent}
                      className={s.row}
                      onMouseMove={() => i !== actionCurrent && setActionAt(i)}
                      onClick={() => finish(actionsOf.id, action.run)}
                    >
                      <div className={s.rowText}>
                        <Text>
                          <Highlighted text={action.title} query={actionQuery} />
                        </Text>
                      </div>
                    </div>
                  ))
                )}
              </>
            ) : rows.length === 0 ? (
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
                      onClick={() => finish(row.item.id, row.item.run)}
                    >
                      <div className={s.rowText}>
                        <span className={s.title}>
                          <Text>
                            <Highlighted text={row.item.title} query={query} />
                          </Text>
                        </span>
                        {row.item.detail ? (
                          <span className={s.detail}>
                            <Truncate expand="none" size="sm" tone="quiet">
                              {row.item.detail}
                            </Truncate>
                          </span>
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
              {actionsOf === null ? "↑↓ move · Enter runs · Esc closes" : "↑↓ move · Enter runs · Esc goes back"}
            </Text>
            {/* Always one button here, so the footer keeps its height as the selection moves. */}
            {actionsOf !== null || hasActions ? (
              <Button variant="quiet" shortcut={kbdK} aria-pressed={actionsOf !== null} onClick={() => (actionsOf === null ? openActions(chosen) : closeActions())}>
                Actions
              </Button>
            ) : (
              <Button variant="quiet" shortcut={display("shortcuts.show", platform)} onClick={openShortcuts}>
                All shortcuts
              </Button>
            )}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
