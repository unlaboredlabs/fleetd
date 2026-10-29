import type { ReactNode } from "react";
import { HIDDEN_WARNING, hasHidden, pieces } from "../../../shared/hidden";
import { Text } from "../../ui";
import s from "./InlineChatItem.module.css";

/**
 * `text` as written, each character that hides or reorders text drawn as its mark (⟨U+202E⟩) in its own left-to-right
 * isolate, so a mark reads the same in any field. `lines`: a body or a block, whose \n breaks the line.
 */
export const marks = (text: string, lines = false): ReactNode[] =>
  pieces(text, lines).map((p, i) =>
    p.mark === undefined ? (
      p.text
    ) : (
      <bdi key={i} dir="ltr" className={s.hidden} data-text="code" data-hidden="" title={`Hidden character ${p.mark.slice(1, -1)}`}>
        {p.mark}
      </bdi>
    ),
  );

/**
 * One field, exactly: its marks, and its direction isolated so its text can't reorder what shows around it. `ltr`:
 * machine text (a command's word, an address, a path), left to right as a terminal shows it; else its own words decide.
 */
export function Exact({ text, lines = false, ltr = false }: { text: string; lines?: boolean; ltr?: boolean }) {
  return <bdi dir={ltr ? "ltr" : "auto"}>{marks(text, lines)}</bdi>;
}

/** The card's line under its head once any field holds a marked character. `lines`: those fields shown as blocks. */
export function HiddenWarning({ fields, lines = [] }: { fields: ReadonlyArray<string | undefined>; lines?: ReadonlyArray<string | undefined> }) {
  const found = fields.some((f) => f !== undefined && hasHidden(f)) || lines.some((f) => f !== undefined && hasHidden(f, true));
  return found ? (
    <p className={s.outcome}>
      <Text size="sm" tone="warning" strong>
        {HIDDEN_WARNING}
      </Text>
    </p>
  ) : null;
}
