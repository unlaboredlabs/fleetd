// A chat image, large: fit to the window over a dim backdrop, its caption under it. Esc, a click beside it or the X
// closes it; with more than one image in the message, ← and → (or the buttons at the edges) step between them. The
// download button beside the X and the image's right-click menu save or copy it, as in the message (picture.tsx).
import { Dialog as D } from "radix-ui";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { createContext, useContext, type KeyboardEvent, type MouseEvent } from "react";
import { PREVIEW_SIDE } from "../../../shared/transfer";
import { useToolQuery } from "../../src/data/react";
import { Button, Text, Tooltip } from "../../ui";
import { PictureMenu, usePicture } from "./picture";
import { stepShot, type Shot } from "./shots";
import type { ProjectRef } from "./slots";
import v from "./viewer.module.css";

/** Opens the viewer on one of the message's images; undefined where no viewer is (a block shown outside the chat). */
export const ImageViewerContext = createContext<((attachmentId: string) => void) | undefined>(undefined);

export const useOpenImage = (): ((attachmentId: string) => void) | undefined => useContext(ImageViewerContext);

export function ImageViewer({ project, shots, at, onAt }: { project: ProjectRef; shots: readonly Shot[]; at: string; onAt: (at: string | undefined) => void }) {
  const n = shots.findIndex((s) => s.attachmentId === at);
  const shot = shots[n];
  // The bubble already read its preview: shown at once, until the picture itself comes.
  const quick = useToolQuery("attachment_get", { projectRef: project, attachmentId: at, maxSide: PREVIEW_SIDE.desktop });
  const got = useToolQuery("attachment_get", { projectRef: project, attachmentId: at }, { enabled: quick.data?.preview === true });
  const data = quick.data?.preview === true ? (got.data ?? quick.data) : quick.data;
  const before = stepShot(shots, at, -1);
  const after = stepShot(shots, at, 1);
  const label = shot?.caption ?? shot?.name ?? data?.name ?? "Image";
  const name = shot?.name ?? data?.name;
  const picture = usePicture(project, { attachmentId: at, name });
  // The image's menu is drawn outside the viewer but is the viewer's child to React: its keys and clicks are its own.
  const inMenu = (e: KeyboardEvent | MouseEvent) => e.target instanceof Element && e.target.closest("[role='menu']") !== null;
  const onKeyDown = (e: KeyboardEvent) => {
    const to = e.key === "ArrowLeft" ? before : e.key === "ArrowRight" ? after : undefined;
    if (to === undefined || inMenu(e)) return;
    e.preventDefault();
    onAt(to);
  };
  // A click anywhere but the image, its caption or a button closes it, as a click on the backdrop would.
  const onClick = (e: MouseEvent) => {
    if (e.target instanceof Element && e.target.closest("img, button, figcaption") === null && !inMenu(e)) onAt(undefined);
  };
  return (
    <D.Root open onOpenChange={(open) => !open && onAt(undefined)}>
      <D.Portal>
        <D.Overlay className={v.backdrop} />
        <D.Content className={v.viewer} data-viewer aria-label={label} aria-labelledby={undefined} aria-describedby={undefined} onKeyDown={onKeyDown} onClick={onClick}>
          <figure className={v.figure}>
            {data === undefined ? (
              <Text size="sm" tone="quiet">
                {quick.isError ? "Couldn’t load this." : "Loading…"}
              </Text>
            ) : (
              <PictureMenu actions={picture}>
                <img key={at} className={v.image} src={`data:${data.mime};base64,${data.dataB64}`} alt={label} />
              </PictureMenu>
            )}
            {shot?.caption !== undefined || shots.length > 1 ? (
              <figcaption className={v.caption}>
                {shot?.caption !== undefined ? <Text size="sm">{shot.caption}</Text> : null}
                {shots.length > 1 ? <Text size="xs" tone="quiet" tabular>{`${String(n + 1)} of ${String(shots.length)}`}</Text> : null}
              </figcaption>
            ) : null}
          </figure>
          <D.Close asChild>
            <Button className={v.close} variant="quiet" iconOnly aria-label="Close">
              <X />
            </Button>
          </D.Close>
          {/* After the X, which the viewer opens with the focus on. */}
          <Tooltip content="Save to Downloads" side="bottom">
            <Button className={v.save} variant="quiet" iconOnly aria-label={name === undefined ? "Save image" : `Save ${name}`} disabled={picture.busy} onClick={() => void picture.download()}>
              <Download />
            </Button>
          </Tooltip>
          {before !== undefined ? (
            <Button className={v.before} variant="quiet" iconOnly aria-label="Previous image" onClick={() => onAt(before)}>
              <ChevronLeft />
            </Button>
          ) : null}
          {after !== undefined ? (
            <Button className={v.after} variant="quiet" iconOnly aria-label="Next image" onClick={() => onAt(after)}>
              <ChevronRight />
            </Button>
          ) : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
