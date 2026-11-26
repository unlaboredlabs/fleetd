// The small dialog that names a new section or renames one (SectionLabel.tsx draws the rest): apart, so the sidebar
// loads it only once it is needed, never with the first chat.
import { useState } from "react";
import type { ChatSection } from "../../../shared/contracts";
import { Button, Dialog, Field, Input } from "../../ui";
import { projectId } from "./model";
import type { Naming } from "./SectionLabel";
import { sectionNameProblem } from "./sections";

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
