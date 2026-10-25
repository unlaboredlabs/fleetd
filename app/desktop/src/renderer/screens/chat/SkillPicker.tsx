// The composer's `$` list (skillPicker.ts has the rules): the project's skills that fit what follows `$`, above the
// box. ↑/↓ move, Tab or Enter picks, Esc closes; the mouse picks too. The composer asks it first on each key.
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { Text } from "../../ui";
import { useData, useToolQuery } from "../../src/data/react";
import { completions, namedSkills, pick, skillToken, type SkillOption } from "./skillPicker";
import s from "./skillPicker.module.css";

interface ProjectRef {
  readonly machineId: string;
  readonly projectId: string;
}

export function useSkillPicker(project: ProjectRef, text: string, setText: (text: string) => void, box: RefObject<HTMLTextAreaElement | null>) {
  const live = useData((st) => st.hub.phase === "live");
  const list = useToolQuery("skills_list", { projectRef: project }, { enabled: live });
  const skills: SkillOption[] = useMemo(
    () => (list.data?.skills ?? []).filter((k) => k.shadowedBy === undefined).map((k) => ({ name: k.name, description: k.description })),
    [list.data],
  );
  const known = useMemo(() => new Set(skills.map((k) => k.name)), [skills]);
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const token = skillToken(text, Math.min(caret, text.length));
  const options = token === null || token.start === closedAt ? [] : completions(token.query, skills);
  const at = Math.min(index, Math.max(options.length - 1, 0));
  // Drawn fixed over the chat, as menus are, just above the box's top edge.
  const anchor = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  const open = options.length > 0;
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (r) setPlace({ left: r.left + 8, width: Math.max(r.width - 16, 0), bottom: window.innerHeight - r.top + 4 });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  const choose = (o: SkillOption) => {
    if (token === null) return;
    const next = pick(text, caret, token.start, o.name);
    setText(next.text);
    setCaret(next.caret);
    setIndex(0);
    requestAnimationFrame(() => box.current?.setSelectionRange(next.caret, next.caret));
  };

  /** True when the key was the list's. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (options.length === 0 || e.nativeEvent.isComposing) return false;
    const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (move !== 0) setIndex((at + move + options.length) % options.length);
    else if ((e.key === "Tab" || e.key === "Enter") && !e.shiftKey) {
      const o = options[at];
      if (o) choose(o);
    } else if (e.key === "Escape") setClosedAt(token?.start ?? null);
    else return false;
    e.preventDefault();
    return true;
  };

  /** Keeps the caret, which decides the token. */
  const track = (el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart);
    if (closedAt !== null && skillToken(el.value, el.selectionStart)?.start !== closedAt) setClosedAt(null);
  };

  const popup =
    options.length === 0 ? null : (
      <div className={s.anchor} ref={anchor}>
        <ul className={s.list} style={place} role="listbox" aria-label="Skills">
        {options.map((o, i) => (
          <li
            key={o.name}
            role="option"
            aria-selected={i === at}
            className={s.option}
            data-active={i === at || undefined}
            onMouseDown={(e) => {
              e.preventDefault();
              choose(o);
            }}
          >
            <Text size="sm" strong>{`$${o.name}`}</Text>
            <Text size="xs" tone="quiet" className={s.description}>
              {o.description}
            </Text>
          </li>
        ))}
        </ul>
      </div>
    );

  return { onKeyDown, track, popup, named: (t: string) => namedSkills(t, known) };
}
