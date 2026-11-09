// What the sidebar draws of your sections (sections.ts): a section's quiet label over its chats, which a click folds to
// one line (its name, how many chats, a chevron, and a dot while one of them waits on you or has a new message); a
// row's Move to section, with a tick on its own; and the small dialog that names a new section or renames one.
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useState, type ComponentProps } from "react";
import type { ChatSection, ProjectRef } from "../../../shared/contracts";
import { Button, ContextMenuItem, ContextMenuRadioGroup, ContextMenuRadioItem, ContextMenuSeparator, ContextMenuSub, Dialog, Field, Input, toast, Truncate } from "../../ui";
import { foldedWords, roomForSection, sectionNameProblem, sectionOf, SECTIONS_MAX, type SectionLine } from "./sections";
import { projectId } from "./model";
import s from "./sidebar.module.css";

interface LabelProps extends Omit<ComponentProps<"button">, "children"> {
  readonly line: Extract<SectionLine<unknown>, { t: "section" }>;
  /** A chat dragged over the section would join it if let go. */
  readonly taking: boolean;
}

/** A section's label, a button that folds it. The menu's trigger props go on it. */
export function SectionLabel({ line, taking, ...rest }: LabelProps) {
  const { section, folded, count, dot } = line;
  return (
    <button
      type="button"
      className={s.sectionHead}
      aria-expanded={!folded}
      aria-description={folded ? foldedWords(count, dot) : undefined}
      data-section-label={section.id}
      data-taking={taking || undefined}
      {...rest}
    >
      <Truncate size="sm" tone="inherit" expand="none" className={s.sectionName}>
        {section.name}
      </Truncate>
      {folded ? (
        <span className={s.sectionCount} aria-hidden>
          {count}
        </span>
      ) : null}
      {folded ? <ChevronRight aria-hidden /> : <ChevronDown aria-hidden />}
      {folded && dot !== undefined ? <span className={s.dot} data-want={dot === "you" ? "you" : undefined} aria-hidden /> : null}
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

/** Asks for a section's name: `onName` gets it, trimmed, once it is one the hub would take. */
export function SectionNameDialog(props: { naming: Naming | null; sections: readonly ChatSection[]; onName: (naming: Naming, name: string) => void; onClose: () => void }) {
  const { naming } = props;
  // The box starts at the current name, or empty; a key per use resets it.
  return naming === null ? <Dialog open={false} title="" /> : <NameBody key={naming.t === "new" ? `new:${projectId(naming.chat)}` : naming.section.id} {...props} naming={naming} />;
}

function NameBody({ naming, sections, onName, onClose }: { naming: Naming; sections: readonly ChatSection[]; onName: (naming: Naming, name: string) => void; onClose: () => void }) {
  const was = naming.t === "rename" ? naming.section.name : "";
  const [name, setName] = useState(was);
  // An empty box says nothing yet.
  const problem = name.trim() === "" ? undefined : sectionNameProblem(sections, name, naming.t === "rename" ? naming.section.id : undefined);
  const ready = problem === undefined && name.trim() !== "" && name.trim() !== was;
  const save = () => {
    if (!ready) return;
    onName(naming, name.trim());
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={naming.t === "new" ? "New section" : `Rename ${was}`}
      description={naming.t === "new" ? `${naming.title} moves into it. Sections are yours: nobody else sees them.` : "Its chats stay in it."}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={save}>
            {naming.t === "new" ? "Create" : "Rename"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Name" error={problem}>
          <Input value={name} autoFocus autoComplete="off" onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}
