// A picture in the composer before it goes: a small square of it, its name and size in its tooltip, dimmed while it
// uploads and edged in red if it didn't, with remove (and Try again) at its corner. A click shows it large, as the
// viewer shows a sent one, from the file on this computer (nothing is read back from the workspace).
import { Dialog as D } from "radix-ui";
import { RotateCw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, cx, Text, Tooltip } from "../../ui";
import { fmtBytes } from "./attachments";
import type { Attached } from "./drafts";
import c from "./composer.module.css";
import v from "./viewer.module.css";

export function PictureChip({ a, onRemove, onRetry }: { a: Attached & { thumb: NonNullable<Attached["thumb"]> }; onRemove: () => void; onRetry: (() => void) | undefined }) {
  const [open, setOpen] = useState(false);
  const failed = a.upload !== undefined && !a.upload.ok;
  const state = a.upload === undefined ? "uploading…" : a.upload.ok ? fmtBytes(a.bytes) : "didn’t upload";
  return (
    <span className={cx(c.thumb, failed && c.thumbFailed)} data-uploading={a.upload === undefined ? "" : undefined}>
      <Tooltip content={`${a.name} · ${state}`}>
        <button type="button" className={c.thumbOpen} aria-label={`Show ${a.name}`} onClick={() => setOpen(true)}>
          <img src={a.thumb.src} alt="" draggable={false} />
        </button>
      </Tooltip>
      <span className={c.thumbTools}>
        {onRetry !== undefined ? (
          <button type="button" className={c.thumbTool} aria-label={`Try ${a.name} again`} onClick={onRetry}>
            <RotateCw aria-hidden />
          </button>
        ) : null}
        <button type="button" className={c.thumbTool} aria-label={`Remove ${a.name}`} onClick={onRemove}>
          <X aria-hidden />
        </button>
      </span>
      {open ? <Large file={a.thumb.picture} name={a.name} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

function Large({ file, name, onClose }: { file: File; name: string; onClose: () => void }) {
  const [src, setSrc] = useState<string | undefined>(undefined);
  useEffect(() => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" && setSrc(reader.result);
    reader.readAsDataURL(file);
    return () => reader.abort();
  }, [file]);
  return (
    <D.Root open onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className={v.backdrop} />
        <D.Content className={v.viewer} data-viewer aria-label={name} aria-describedby={undefined} onClick={(e) => e.target === e.currentTarget && onClose()}>
          <figure className={v.figure} onClick={(e) => e.target === e.currentTarget && onClose()}>
            {src === undefined ? (
              <Text size="sm" tone="quiet">
                Loading…
              </Text>
            ) : (
              <img className={v.image} src={src} alt={name} />
            )}
            <figcaption className={v.caption}>
              <Text size="sm">{name}</Text>
            </figcaption>
          </figure>
          <D.Close asChild>
            <Button className={v.close} variant="quiet" iconOnly aria-label="Close">
              <X />
            </Button>
          </D.Close>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
