// Settings › Projects › Project's Picture: the circle its chat shows on every device in place of its letters. Click it
// (or Choose…) to pick an image, or drop one on it; Move and Scale shows it in the circle to drag and zoom (the wheel
// or the slider, about the pointer: shared/crop.ts) before Save sends it as it is with the square to keep
// (attachment_put, then project_avatar_set's crop). The hub keeps that square alone, small and without the file's
// metadata. Remove brings the letters back.
import { Camera } from "lucide-react";
import { useRef, useState, type DragEvent, type PointerEvent, type WheelEvent } from "react";
import { baseScale, clampPan, clampZoom, cropOf, MAX_ZOOM, zoomAbout, type Size } from "../../../shared/crop";
import type { AttachmentMime, ProjectSummary } from "../../../shared/contracts";
import { useDataLayer } from "../../src/data/react";
import { Button, Dialog, Text } from "../../ui";
import { upload } from "../chat/drafts";
import { ProjectAvatar } from "../projects/ProjectAvatar";
import { errorText, useHubCall } from "./hub";
import { Setting } from "./parts";
import p from "./Picture.module.css";
import s from "./settings.module.css";

type Pictured = Pick<ProjectSummary, "machineId" | "projectId" | "title" | "kind" | "avatar">;
type Picked = { readonly file: File; readonly mime: AttachmentMime; readonly url: string; readonly size: Size };

const TAKES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
/** The circle's side in Move and Scale, and the stage's around it. */
const CIRCLE = 240;
const STAGE = 300;

/** The image a person picked or dropped, read for its size; why not, when it can't be. */
export const readPicked = (file: File): Promise<Picked | string> => {
  if (!TAKES.includes(file.type)) return Promise.resolve(`${file.name} isn't a png, jpeg or webp image.`);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(`${file.name} couldn't be read.`);
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const img = new Image();
      img.onerror = () => resolve(`${file.name} couldn't be read as an image.`);
      img.onload = () => resolve({ file, mime: file.type as AttachmentMime, url, size: { width: img.naturalWidth, height: img.naturalHeight } });
      img.src = url;
    };
    reader.readAsDataURL(file);
  });
};

export function PictureSetting({ project }: { project: Pictured }) {
  const layer = useDataLayer();
  const hubCall = useHubCall();
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [echo, setEcho] = useState<{ ok: boolean; text: string } | null>(null);
  const ref = { machineId: project.machineId, projectId: project.projectId };

  const take = (file: File | undefined) => {
    if (file === undefined) return;
    setEcho(null);
    void readPicked(file).then((r) => (typeof r === "string" ? setEcho({ ok: false, text: r }) : setPicked(r)));
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!busy) take(e.dataTransfer.files[0]);
  };
  const over = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };
  const save = async (crop: ReturnType<typeof cropOf>) => {
    if (picked === null) return;
    setBusy(true);
    try {
      const sent = await upload(layer, picked.file, picked.mime);
      if (!sent.ok) throw new Error(sent.message);
      await hubCall("project_avatar_set", { ...ref, attachmentId: sent.ref.attachmentId, crop }, { timeoutMs: 120_000 });
      setPicked(null);
      setEcho({ ok: true, text: "Its chat shows this picture now, here and on your phone." });
    } catch (e) {
      setEcho({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setEcho(null);
    try {
      await hubCall("project_avatar_set", ref);
      setEcho({ ok: true, text: "Removed: its letters show again." });
    } catch (e) {
      setEcho({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Setting reveal="projects.picture" label="Picture" help="Its chat shows it on every device, in place of its letters. Drop an image on it, or choose one.">
      <div className={s.inline}>
        <button
          type="button"
          className={p.target}
          data-dragging={dragging || undefined}
          aria-label={project.avatar === undefined ? `Choose a picture for ${project.title}` : `Change ${project.title}'s picture`}
          disabled={busy}
          onClick={() => input.current?.click()}
          onDragOver={over}
          onDragEnter={over}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
        >
          <ProjectAvatar project={project} size={64} />
          <span className={p.hover} aria-hidden>
            <Camera />
          </span>
        </button>
        <Button disabled={busy} onClick={() => input.current?.click()}>
          Choose…
        </Button>
        {project.avatar === undefined ? null : (
          <Button variant="quiet" disabled={busy} onClick={() => void remove()}>
            Remove
          </Button>
        )}
        <input
          ref={input}
          type="file"
          accept={TAKES.join(",")}
          hidden
          data-testid="picture-file"
          onChange={(e) => {
            take(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      {echo === null ? null : (
        <div role={echo.ok ? "status" : "alert"}>
          <Text size="sm" tone={echo.ok ? "quiet" : "danger"}>
            {echo.text}
          </Text>
        </div>
      )}
      {picked === null ? null : <MoveAndScale picked={picked} busy={busy} onCancel={() => setPicked(null)} onSave={(crop) => void save(crop)} />}
    </Setting>
  );
}

/** The picked image in a circle, to drag and zoom; Save hands back the square under the circle. */
export function MoveAndScale({ picked, busy, onCancel, onSave }: { picked: Picked; busy: boolean; onCancel: () => void; onSave: (crop: ReturnType<typeof cropOf>) => void }) {
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const picture = picked.size;
  const scale = baseScale(picture, CIRCLE);
  const to = (zoom: number, x: number, y: number) => setView({ zoom, ...clampPan(picture, CIRCLE, zoom, x, y) });
  // About a point given from the circle's centre.
  const zoomTo = (zoom: number, fx: number, fy: number) => {
    const k = clampZoom(zoom);
    to(k, zoomAbout(view.x, fx, view.zoom, k), zoomAbout(view.y, fy, view.zoom, k));
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const at = drag.current;
    if (at === null) return;
    drag.current = { x: e.clientX, y: e.clientY };
    to(view.zoom, view.x + e.clientX - at.x, view.y + e.clientY - at.y);
  };
  const wheel = (e: WheelEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    zoomTo(view.zoom * Math.exp(-e.deltaY * 0.002), e.clientX - box.left - box.width / 2, e.clientY - box.top - box.height / 2);
  };
  const w = picture.width * scale;
  const h = picture.height * scale;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onCancel()}
      title="Move and scale"
      description="Drag to move it, scroll or slide to zoom. What's inside the circle is kept."
      footer={
        <>
          <Button variant="quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => onSave(cropOf(picture, CIRCLE, view.zoom, view.x, view.y))}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className={p.crop}>
        <div
          className={p.stage}
          style={{ width: STAGE, height: STAGE }}
          data-testid="picture-stage"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onWheel={wheel}
        >
          <img
            className={p.image}
            src={picked.url}
            alt=""
            draggable={false}
            style={{ width: w, height: h, left: (STAGE - w) / 2, top: (STAGE - h) / 2, transform: `translate(${String(view.x)}px, ${String(view.y)}px) scale(${String(view.zoom)})` }}
          />
          <div className={p.circle} style={{ width: CIRCLE, height: CIRCLE }} aria-hidden />
        </div>
        <input
          type="range"
          className={p.slider}
          aria-label="Zoom"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={view.zoom}
          onChange={(e) => zoomTo(Number(e.target.value), 0, 0)}
        />
      </div>
    </Dialog>
  );
}
