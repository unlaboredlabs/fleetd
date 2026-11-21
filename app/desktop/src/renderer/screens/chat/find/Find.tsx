// The chat's search (⌘F): a glass field floating at the top row's end, over the conversation. Results come as you
// type, newest first with your words marked, under it; filters are chips in the field, typed (`from:lead`, `has:link`,
// `on:2026-10-14`) or picked from the list. Enter opens the selected hit in the chat; after that Enter and ⇧Enter (or
// ↓ and ↑) step to the next older and newer one, with "3 of 48" at the field's end. Esc closes it, and the chat goes
// back to where you were. The hub searches the whole chat (chat_find): nothing here depends on what is loaded.
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ChatFindHit } from "../../../../shared/contracts";
import { Button, cx } from "../../../ui";
import { useDataLayer } from "../../../src/data/react";
import { useNow } from "../../live/clock";
import type { ProjectRef } from "../slots";
import { whenOf, whoOf } from "../pins/pins";
import { asks, chipLabel, chipOf, countLabel, findInput, suggestions, withChip, type Chip, type Who } from "./model";
import s from "./find.module.css";

/** How long typing pauses before the hub is asked. */
const PAUSE_MS = 120;
const PAGE = 20;

type Found = { readonly hits: readonly ChatFindHit[]; readonly more: boolean; readonly count?: number | undefined; readonly countMore: boolean };

export interface FindProps {
  readonly project: ProjectRef;
  /** The bot's name, for the lead's hits. */
  readonly bot: string;
  readonly who: Who;
  /** Opens the chat at a hit. */
  readonly onJump: (messageId: string) => void;
  /** Esc or ×: the field goes, and the chat back to where it was. */
  readonly onClose: () => void;
  /** The names people go by now, by id. */
  readonly names: ReadonlyMap<string, string>;
}

export function Find(props: FindProps) {
  const { project, onJump, onClose, who } = props;
  const layer = useDataLayer();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [chips, setChips] = useState<readonly Chip[]>([]);
  const [shownFound, setFound] = useState<Found>();
  const [loading, setLoading] = useState(false);
  /** The list under the field: open while typing, closed once a hit is open in the chat. */
  const [listOpen, setListOpen] = useState(true);
  /** The row the list's selection is on. */
  const [selected, setSelected] = useState(0);
  /** The hit open in the chat, by its place in the hits. */
  const [at, setAt] = useState<number>();
  const asked = useRef(0);
  const nowMs = useNow(true, 60_000);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const last = text.split(/\s+/).at(-1) ?? "";
  const offered = useMemo(() => (listOpen ? suggestions(text.trim() === "" ? "" : last, who).filter((c) => !chips.some((h) => chipLabel(h) === chipLabel(c))) : []), [listOpen, text, last, who, chips]);
  const words = offered.length > 0 && last.includes(":") ? text.slice(0, text.length - last.length) : text;

  // As you type: the first page of what the words and chips find, a moment after the typing stops.
  const active = asks(words, chips);
  useEffect(() => {
    const n = ++asked.current;
    if (!active) return;
    const t = setTimeout(() => {
      setLoading(true);
      void layer.call("chat_find", { ...findInput(project, words, chips, who.me), limit: PAGE }).then((r) => {
        if (asked.current !== n) return;
        setLoading(false);
        if (!r.ok) return;
        const out = r.output;
        setFound({ hits: out.hits, more: out.more, count: out.count, countMore: out.countMore === true });
        setSelected(0);
        setAt(undefined);
      });
    }, PAUSE_MS);
    return () => clearTimeout(t);
  }, [layer, project, words, chips, who.me, active]);
  const found = active ? shownFound : undefined;

  const paging = useRef(false);
  const more = useCallback(async (): Promise<readonly ChatFindHit[] | undefined> => {
    const f = found;
    const tail = f?.hits.at(-1);
    if (f === undefined || !f.more || tail === undefined || paging.current) return undefined;
    paging.current = true;
    const n = asked.current;
    const r = await layer.call("chat_find", { ...findInput(project, words, chips, who.me), before: tail.messageId, limit: PAGE });
    paging.current = false;
    if (asked.current !== n || !r.ok) return undefined;
    const out = r.output;
    const hits = [...f.hits, ...out.hits];
    setFound({ ...f, hits, more: out.more });
    return hits;
  }, [found, layer, project, words, chips, who.me]);

  const jump = (i: number, hits = found?.hits) => {
    const hit = hits?.[i];
    if (hit === undefined) return;
    setAt(i);
    setSelected(i);
    setListOpen(false);
    onJump(hit.messageId);
    if (hits !== undefined && i >= hits.length - 3) void more();
  };
  /** The next older (1) or newer (-1) hit, read on past the loaded page when there is more. */
  const step = async (d: 1 | -1) => {
    const hits = found?.hits;
    if (hits === undefined || hits.length === 0) return;
    const next = (at ?? -1) + d;
    if (next < 0) return;
    if (next >= hits.length) {
      const longer = await more();
      if (longer !== undefined && next < longer.length) jump(next, longer);
      return;
    }
    jump(next);
  };

  const addChip = (chip: Chip, rest: string) => {
    setChips((c) => withChip(c, chip));
    setText(rest);
    setListOpen(true);
    input.current?.focus();
  };
  const rows = offered.length > 0 ? offered.length : (found?.hits.length ?? 0);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Backspace" && text === "" && chips.length > 0) {
      e.preventDefault();
      setChips((c) => c.slice(0, -1));
      return;
    }
    if (e.key === " " && last.includes(":")) {
      const chip = chipOf(last, who, Date.now());
      if (chip !== undefined) {
        e.preventDefault();
        addChip(chip, text.slice(0, text.length - last.length));
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      if (listOpen && rows > 0) {
        const next = Math.min(Math.max(selected + d, 0), rows - 1);
        setSelected(next);
        if (offered.length === 0 && found !== undefined && next >= found.hits.length - 3) void more();
      } else void step(d);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (listOpen && offered.length > 0) {
        const chip = offered[Math.min(selected, offered.length - 1)];
        if (chip !== undefined) addChip(chip, words);
        return;
      }
      const typed = last.includes(":") ? chipOf(last, who, Date.now()) : undefined;
      if (typed !== undefined) {
        addChip(typed, text.slice(0, text.length - last.length));
        return;
      }
      if (listOpen && (found?.hits.length ?? 0) > 0) jump(selected);
      else void step(e.shiftKey ? -1 : 1);
    }
  };

  const count = countLabel(found?.count, found?.countMore === true, at);
  const showList = listOpen && (offered.length > 0 || (found !== undefined && found.hits.length > 0));
  return (
    <div className={s.find} role="search" data-floats="" data-find="">
      <div className={s.field} onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
        <Search className={s.glass} aria-hidden />
        {chips.map((c, i) => (
          <span key={`${String(i)}${chipLabel(c)}`} className={s.chip}>
            {chipLabel(c)}
            <button type="button" className={s.unchip} aria-label={`Remove ${chipLabel(c)}`} onClick={() => setChips((all) => all.filter((x) => x !== c))}>
              <X aria-hidden />
            </button>
          </span>
        ))}
        <input
          ref={input}
          className={s.input}
          value={text}
          placeholder={chips.length === 0 ? "Search" : ""}
          aria-label="Search this chat"
          aria-expanded={showList}
          aria-controls="find-results"
          role="combobox"
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setListOpen(true);
            setSelected(0);
          }}
          onFocus={() => setListOpen(true)}
          onKeyDown={onKey}
        />
        {count !== undefined ? (
          <span className={cx(s.count, loading && s.counting)} aria-live="polite">
            {count}
          </span>
        ) : null}
        <span className={s.steps}>
          <Button variant="quiet" iconOnly aria-label="Newer result" disabled={at === undefined || at === 0} onMouseDown={(e) => e.preventDefault()} onClick={() => void step(-1)}>
            <ChevronUp />
          </Button>
          <Button
            variant="quiet"
            iconOnly
            aria-label="Older result"
            disabled={found === undefined || found.hits.length === 0 || ((at ?? -1) >= found.hits.length - 1 && !found.more)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void step(1)}
          >
            <ChevronDown />
          </Button>
          <Button variant="quiet" iconOnly aria-label="Close search" onClick={onClose}>
            <X />
          </Button>
        </span>
      </div>
      {showList ? (
        <div className={s.results} id="find-results" role="listbox" aria-label={offered.length > 0 ? "Filters" : "Results"}>
          {offered.length > 0
            ? offered.map((c, i) => (
                <div
                  key={chipLabel(c)}
                  role="option"
                  aria-selected={i === selected}
                  className={cx(s.row, s.filter, i === selected && s.selected)}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => addChip(c, words)}
                >
                  {chipLabel(c)}
                </div>
              ))
            : found?.hits.map((h, i) => (
                <div
                  key={h.messageId}
                  role="option"
                  aria-selected={i === selected}
                  className={cx(s.row, i === selected && s.selected)}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => jump(i)}
                  ref={i === selected ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                >
                  <span className={s.head}>
                    <span className={s.who}>{whoOf(h, props.bot, who.me, props.names)}</span>
                    <span className={s.when}>{whenOf(h.createdAt, nowMs)}</span>
                  </span>
                  <span className={s.line}>{marked(h.text, h.marks)}</span>
                </div>
              ))}
        </div>
      ) : null}
    </div>
  );
}

/** The line with its marks. */
export function marked(text: string, marks: readonly (readonly [number, number])[]): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  for (const [a, b] of marks) {
    if (a > i) out.push(text.slice(i, a));
    out.push(<mark key={a}>{text.slice(a, b)}</mark>);
    i = b;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}
