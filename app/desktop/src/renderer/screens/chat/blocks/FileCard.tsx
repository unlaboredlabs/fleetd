// A file in a message as a card: its kind's glyph, name, kind and size, with Open (in this computer's app for its
// type) and Save. Main reads the file from the hub for either (main/files.ts), so a large one never loads into the
// page. A Navi's `file` block, and any file a message carries that isn't an image.
import { Download, File, FileArchive, FileImage, FileSpreadsheet, FileText, Presentation, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { glyphOf, kindOf, type FileGlyph } from "../../../../shared/files";
import { useDataLayer } from "../../../src/data/react";
import { Button, Text, toast, Truncate } from "../../../ui";
import { fmtBytes } from "../attachments";
import type { ProjectRef } from "../slots";
import b from "./blocks.module.css";

const GLYPHS: Record<FileGlyph, LucideIcon> = {
  pdf: FileText,
  doc: FileText,
  text: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  zip: FileArchive,
  image: FileImage,
  file: File,
};

export type CardFile = { readonly attachmentId: string; readonly name: string; readonly mime: string; readonly bytes: number | undefined };

export function FileCard({ project, file, caption }: { project: ProjectRef | undefined; file: CardFile; caption?: string | undefined }) {
  const { hub } = useDataLayer();
  const [busy, setBusy] = useState<"open" | "save" | undefined>(undefined);
  const glyph = glyphOf(file.mime);
  const Glyph = GLYPHS[glyph];
  const meta = file.bytes === undefined ? kindOf(file.mime) : `${kindOf(file.mime)} · ${fmtBytes(file.bytes)}`;
  const act = async (what: "open" | "save") => {
    if (project === undefined || busy !== undefined) return;
    setBusy(what);
    const request = { projectRef: project, attachmentId: file.attachmentId };
    const out = await (what === "open" ? window.fleetd.files.open(hub, request) : window.fleetd.files.save(hub, request)).catch((e: unknown) => ({ ok: false as const, message: String(e) }));
    setBusy(undefined);
    if (!out.ok) toast({ tone: "danger", title: what === "open" ? `Couldn’t open ${file.name}` : `Couldn’t save ${file.name}`, description: out.message });
  };
  return (
    <div className={b.file} data-block="file">
      <div className={b.fileRow} onDoubleClick={() => void act("open")}>
        <span className={b.fileGlyph} data-glyph={glyph} aria-hidden>
          <Glyph />
        </span>
        <span className={b.fileText}>
          {/* A file name is a machine token: the code voice, as the composer's chips show it. */}
          <span data-text="code">
            <Truncate size="sm" mono expand="none">
              {file.name}
            </Truncate>
          </span>
          <Text size="xs" tone="quiet" tabular>
            {meta}
          </Text>
        </span>
        {project !== undefined ? (
          <span className={b.fileActions}>
            <Button variant="secondary" disabled={busy !== undefined} onClick={() => void act("open")}>
              {busy === "open" ? "Opening…" : "Open"}
            </Button>
            <Button variant="ghost" iconOnly icon={<Download />} aria-label={`Save ${file.name}`} title="Save…" disabled={busy !== undefined} onClick={() => void act("save")} />
          </span>
        ) : null}
      </div>
      {caption !== undefined ? (
        <Text size="xs" tone="quiet">
          {caption}
        </Text>
      ) : null}
    </div>
  );
}
