// What a picture in the chat offers besides opening large: a download button on it, shown while the pointer or the
// keyboard is on the picture, which saves the hub's own file to the Downloads folder in one click and says so with a
// way to show it there; and Save image… (asks where) and Copy image in its right-click menu. Main reads the file from
// the hub for each (main/files.ts), as it does for a file card. An image block, a picture sent with a message and the
// viewer's picture all offer the same.
import { Download } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";
import { useDataLayer } from "../../src/data/react";
import { ContextMenu, ContextMenuItem, cx, toast, Tooltip } from "../../ui";
import type { ProjectRef } from "./slots";
import p from "./picture.module.css";

/** A picture on the hub; its name is said once it is known (an image block's comes with its bytes). */
export type PictureFile = { readonly attachmentId: string; readonly name: string | undefined };

const failed = (e: unknown) => ({ ok: false as const, message: String(e) });

/** The picture's three actions; `busy` while one of them reads the file. */
export function usePicture(project: ProjectRef | undefined, file: PictureFile) {
  const { hub } = useDataLayer();
  const [busy, setBusy] = useState(false);
  const name = file.name ?? "the image";
  const run = async <T extends { readonly ok: boolean }>(act: (request: { projectRef: ProjectRef; attachmentId: string }) => Promise<T>): Promise<T | undefined> => {
    if (project === undefined || busy) return undefined;
    setBusy(true);
    const out = await act({ projectRef: project, attachmentId: file.attachmentId });
    setBusy(false);
    return out;
  };
  const show = async (path: string) => {
    const out = await window.fleetd.files.show(path).catch(failed);
    if (!out.ok) toast({ tone: "danger", title: "Couldn’t show the file", description: out.message });
  };
  return {
    busy,
    /** Straight to the Downloads folder, under its own name. */
    download: async () => {
      const out = await run((request) => window.fleetd.files.download(hub, request).catch(failed));
      if (out === undefined) return;
      if (!out.ok) toast({ tone: "danger", title: `Couldn’t save ${name}`, description: out.message });
      else toast({ tone: "success", title: `Saved ${out.name} to Downloads`, action: { label: window.fleetd.platform === "darwin" ? "Show in Finder" : "Show in folder", onClick: () => void show(out.path) } });
    },
    /** Where the person picks, as a file card's Save does. */
    save: async () => {
      const out = await run((request) => window.fleetd.files.save(hub, request).catch(failed));
      if (out?.ok === false) toast({ tone: "danger", title: `Couldn’t save ${name}`, description: out.message });
    },
    copy: async () => {
      const out = await run((request) => window.fleetd.files.copyImage(hub, request).catch(failed));
      if (out === undefined) return;
      if (!out.ok) toast({ tone: "danger", title: `Couldn’t copy ${name}`, description: out.message });
      else toast({ title: "Image copied", key: "picture-copy" });
    },
  };
}

type Actions = ReturnType<typeof usePicture>;

/** The picture's right-click menu. */
export function PictureMenu({ actions, children }: { actions: Actions; children: ReactElement }) {
  return (
    <ContextMenu
      menu={() => (
        <>
          <ContextMenuItem onSelect={() => void actions.save()}>Save image…</ContextMenuItem>
          <ContextMenuItem onSelect={() => void actions.copy()}>Copy image</ContextMenuItem>
        </>
      )}
    >
      {children}
    </ContextMenu>
  );
}

/**
 * A picture in a message with its download button and its menu: `children` is the picture, or the button that opens it
 * large. The frame is the picture's own box and the button lies over its corner, so nothing moves as it shows. Without
 * a project (a block shown outside a chat) there is no file to read, and the picture is all there is.
 */
export function Picture({ project, file, className, children }: { project: ProjectRef | undefined; file: PictureFile; className?: string | undefined; children: ReactNode }) {
  const actions = usePicture(project, file);
  if (project === undefined) return children;
  return (
    <PictureMenu actions={actions}>
      <span className={cx(p.frame, className)} data-picture>
        {children}
        <Tooltip content="Save to Downloads">
          <button type="button" className={p.save} aria-label={file.name === undefined ? "Save image" : `Save ${file.name}`} disabled={actions.busy} data-busy={actions.busy ? "" : undefined} onClick={() => void actions.download()}>
            <Download aria-hidden />
          </button>
        </Tooltip>
      </span>
    </PictureMenu>
  );
}
