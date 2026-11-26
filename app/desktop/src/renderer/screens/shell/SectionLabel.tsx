// What the sidebar draws of your sections (sections.ts): a section's quiet label over its chats, which a click folds to
// the label alone (W798): then its name, how many chats it holds in the quiet colour, and a dot while one of them waits
// on you or has a new message, no chevron (one hints under the pointer); and a row's Move to section, with a tick on its
// own. The small dialog that names a new section or renames one is SectionName.tsx, loaded on use.
import { ChevronDown, Plus } from "lucide-react";
import type { ComponentProps } from "react";
import type { ChatSection, ProjectRef } from "../../../shared/contracts";
import { ContextMenuItem, ContextMenuRadioGroup, ContextMenuRadioItem, ContextMenuSeparator, ContextMenuSub, toast, Truncate } from "../../ui";
import { foldedWords, roomForSection, sectionOf, SECTIONS_MAX, type SectionLine } from "./sections";
import { projectId } from "./model";
import s from "./sidebar.module.css";

interface LabelProps extends Omit<ComponentProps<"button">, "children"> {
  readonly line: Extract<SectionLine<unknown>, { t: "section" }>;
  /** A chat dragged over the section would join it if let go. */
  readonly taking: boolean;
  /** Its click folds it: one of your sections, not the Bots over the chats in none. */
  readonly folds?: boolean | undefined;
}

/** A section's label, a button that folds it. The menu's trigger props go on it. */
export function SectionLabel({ line, taking, folds = true, ...rest }: LabelProps) {
  const { section, folded, count, dot } = line;
  return (
    <button
      type="button"
      className={s.sectionHead}
      {...(folds ? { "aria-expanded": !folded, "aria-description": folded ? foldedWords(count, dot) : undefined, "data-folds": "" } : {})}
      data-section-label={section.id}
      data-taking={taking || undefined}
      {...rest}
    >
      <Truncate size="sm" tone="inherit" expand="none" className={s.sectionName}>
        {section.name}
      </Truncate>
      {folds && folded ? (
        <span className={s.sectionCount} aria-hidden>
          {count}
        </span>
      ) : null}
      {folds ? <ChevronDown className={s.sectionHint} data-folded={folded || undefined} aria-hidden /> : null}
      {folds && folded && dot !== undefined ? <span className={s.dot} data-want={dot === "you" ? "you" : undefined} data-section-dot="" aria-hidden /> : null}
    </button>
  );
}

/** What the name dialog is for: a new section with `chat` as its first, or another name for `section`. */
export type Naming = { readonly t: "new"; readonly chat: ProjectRef; readonly title: string } | { readonly t: "rename"; readonly section: ChatSection };

/**
 * A row's Move to section: your sections, the chat's own ticked, then No section, then New section… (which asks for
 * its name, `onNew`). `onMove` takes the chat to a section by its id, or out of them all (null).
 */
export function MoveToSection(props: { sections: readonly ChatSection[]; chat: ProjectRef; title: string; onMove: (to: string | null) => void; onNew: (naming: Naming) => void }) {
  const { sections, chat, title } = props;
  return (
    <ContextMenuSub label="Move to section">
      {sections.length === 0 ? null : (
        <>
          <ContextMenuRadioGroup value={sectionOf(sections, projectId(chat))?.id ?? ""} onValueChange={(id) => props.onMove(id === "" ? null : id)}>
            {sections.map((section) => (
              <ContextMenuRadioItem key={section.id} value={section.id}>
                {section.name}
              </ContextMenuRadioItem>
            ))}
            <ContextMenuRadioItem value="">No section</ContextMenuRadioItem>
          </ContextMenuRadioGroup>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem
        icon={<Plus aria-hidden />}
        onSelect={() => {
          if (roomForSection(sections, chat)) return props.onNew({ t: "new", chat, title });
          toast({ title: `Up to ${String(SECTIONS_MAX)} sections`, description: "Remove one to make another." });
        }}
      >
        New section…
      </ContextMenuItem>
    </ContextMenuSub>
  );
}
