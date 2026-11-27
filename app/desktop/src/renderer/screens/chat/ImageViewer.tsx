// A chat image, large: fit to the window over a dim backdrop, its caption under it. Esc, a click beside it or the X
// closes it; ← and → (or the buttons at the edges) step through every picture in the chat. A click on the picture
// zooms in there and another fits it again; a pinch or ⌘-scroll zooms about the pointer, + and − and 0 by the keys
// or the buttons; zoomed in, a drag or a scroll moves it. Copy and the download button beside the X, and the image's
// right-click menu, copy or save it, as in the message (picture.tsx).
import { Dialog as D } from "radix-ui";
import { ChevronLeft, ChevronRight, Copy, Download, Minus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { PREVIEW_SIDE } from "../../../shared/transfer";
import { useToolQuery } from "../../src/data/react";
import { Button, Text, Tooltip } from "../../ui";
import { PictureMenu, usePicture } from "./picture";
import { stepShot, type Shot } from "./shots";
import type { ProjectRef } from "./slots";
import v from "./viewer.module.css";

/** How far the picture zooms past fitting the window, and the steps + and − take. */
const MAX_ZOOM = 8;
const CLICK_ZOOM = 2.5;
const STEP_ZOOM = 1.5;

type View = { readonly z: number; readonly x: number; readonly y: number };
const FIT: View = { z: 1, x: 0, y: 0 };

/**
 * The view zoomed to `z` about the point `p` (from the stage's centre), the picture `w` × `h` as fit: the point under
 * the pointer stays under it, and the picture never leaves an edge of the stage `sw` × `sh` bare while it could cover it.
 */
export const zoomAbout = (v: View, z: number, p: { x: number; y: number }, box: { w: number; h: number; sw: number; sh: number }): View => {
  const to = Math.min(MAX_ZOOM, Math.max(1, z));
  const k = to / v.z;
  return held({ z: to, x: p.x - (p.x - v.x) * k, y: p.y - (p.y - v.y) * k }, box);
};

/** The view moved back in where it went past an edge. */
type Pointed = { readonly clientX: number; readonly clientY: number };

/** The picture as it fits and the stage it is on, in px. */
const boxOf = (img: HTMLImageElement | null, stage: HTMLElement | null) => ({ w: img?.offsetWidth ?? 0, h: img?.offsetHeight ?? 0, sw: stage?.clientWidth ?? 0, sh: stage?.clientHeight ?? 0 });

/** A point from the picture's centre as it fits, before it moved. */
const pointIn = (img: HTMLImageElement | null, e: Pointed, v: View) => {
  const r = img?.getBoundingClientRect();
  return r === undefined ? { x: 0, y: 0 } : { x: e.clientX - (r.left + r.width / 2 - v.x), y: e.clientY - (r.top + r.height / 2 - v.y) };
};

export const held = (v: View, box: { w: number; h: number; sw: number; sh: number }): View => {
  if (v.z <= 1) return FIT;
  const mx = Math.max(0, (box.w * v.z - box.sw) / 2);
  const my = Math.max(0, (box.h * v.z - box.sh) / 2);
  return { z: v.z, x: Math.min(mx, Math.max(-mx, v.x)), y: Math.min(my, Math.max(-my, v.y)) };
};

// The image's menu is drawn outside the viewer but is the viewer's child to React: its keys and clicks are its own.
const inMenu = (e: { readonly target: EventTarget | null }) => e.target instanceof Element && e.target.closest("[role='menu']") !== null;

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
  // Each picture opens fit to the window: a view is its picture's, and another picture's is fit.
  const [zoom, setZoom] = useState<{ readonly at: string; readonly view: View }>({ at, view: FIT });
  const view = zoom.at === at ? zoom.view : FIT;
  const setView = useCallback((change: (v: View) => View) => setZoom((z) => ({ at, view: change(z.at === at ? z.view : FIT) })), [at]);
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | undefined>(undefined);
  const box = () => boxOf(img.current, stage.current);
  const pointOf = (e: Pointed, v: View) => pointIn(img.current, e, v);
  const zoomTo = (z: number, from?: Pointed) => setView((v) => zoomAbout(v, z, from === undefined ? { x: v.x, y: v.y } : pointOf(from, v), box()));
  // A pinch (the trackpad's comes as a wheel with Ctrl) or ⌘-scroll zooms about the pointer, never the page; zoomed
  // in, a scroll moves the picture. Heard here, not passively, so the page's own zoom never takes it.
  // The stage comes with the dialog's portal, after the first render: its listener waits for it.
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const zoomed = view.z > 1;
  useEffect(() => {
    if (stageEl === null) return;
    const wheel = (e: globalThis.WheelEvent) => {
      const picture = stageEl.querySelector("img");
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const from = { clientX: e.clientX, clientY: e.clientY };
        setView((v) => zoomAbout(v, v.z * Math.exp(-e.deltaY / 200), pointIn(picture, from, v), boxOf(picture, stageEl)));
      } else if (zoomed) {
        e.preventDefault();
        setView((v) => held({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }, boxOf(picture, stageEl)));
      }
    };
    stageEl.addEventListener("wheel", wheel, { passive: false });
    return () => stageEl.removeEventListener("wheel", wheel);
  }, [stageEl, zoomed, setView]);
  // Esc closes the viewer at the first press. The page gives it to the layer drawn last, which after a save is the
  // toast saying so and with the keyboard on the download button is its tooltip: each would take a press and leave the
  // viewer open. So the viewer hears it before the page's layers do; the toast stays, with its way to show the file.
  useEffect(() => {
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || inMenu(e)) return;
      e.stopPropagation();
      onAt(undefined);
    };
    window.addEventListener("keydown", esc, { capture: true });
    return () => window.removeEventListener("keydown", esc, { capture: true });
  }, [onAt]);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!inMenu(e) && (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "0")) {
      e.preventDefault();
      zoomTo(e.key === "0" ? 1 : e.key === "-" ? view.z / STEP_ZOOM : view.z * STEP_ZOOM);
      return;
    }
    const to = e.key === "ArrowLeft" ? before : e.key === "ArrowRight" ? after : undefined;
    if (to === undefined || inMenu(e)) return;
    e.preventDefault();
    onAt(to);
  };
  // A click anywhere but the image, its caption or a button closes it, as a click on the backdrop would; one on the
  // image zooms in there, or fits it again.
  const onClick = (e: MouseEvent) => {
    if (inMenu(e) || !(e.target instanceof Element)) return;
    if (e.target === img.current) {
      if (drag.current?.moved !== true) zoomTo(view.z > 1 ? 1 : CLICK_ZOOM, e);
      return;
    }
    if (e.target.closest("img, button, figcaption") === null) onAt(undefined);
  };
  const onPointerDown = (e: PointerEvent) => {
    if (view.z <= 1 || e.button !== 0 || e.target !== img.current) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (d === undefined) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    setView((v) => held({ ...v, x: d.vx + dx, y: d.vy + dy }, box()));
  };
  const onPointerUp = () => {
    // The click after a drag doesn't zoom: it hears `moved` first, then the drag ends.
    setTimeout(() => (drag.current = undefined), 0);
  };
  return (
    <D.Root open onOpenChange={(open) => !open && onAt(undefined)}>
      <D.Portal>
        <D.Overlay className={v.backdrop} />
        <D.Content className={v.viewer} data-viewer aria-label={label} aria-labelledby={undefined} aria-describedby={undefined} onKeyDown={onKeyDown} onClick={onClick}>
          <figure className={v.figure}>
            <div
              ref={(el) => {
                stage.current = el;
                setStageEl(el);
              }}
              className={v.stage}
              data-zoomed={zoomed ? "" : undefined}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              {data === undefined ? (
                <Text size="sm" tone="quiet">
                  {quick.isError ? "Couldn’t load this." : "Loading…"}
                </Text>
              ) : (
                <PictureMenu actions={picture}>
                  <img
                    ref={img}
                    key={at}
                    className={v.image}
                    src={`data:${data.mime};base64,${data.dataB64}`}
                    alt={label}
                    draggable={false}
                    style={view.z > 1 ? { transform: `translate(${String(view.x)}px, ${String(view.y)}px) scale(${String(view.z)})` } : undefined}
                  />
                </PictureMenu>
              )}
            </div>
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
          <div className={v.tools}>
            <Tooltip content="Zoom out" side="bottom">
              <Button variant="quiet" iconOnly aria-label="Zoom out" disabled={view.z <= 1} onClick={() => zoomTo(view.z / STEP_ZOOM)}>
                <Minus />
              </Button>
            </Tooltip>
            <Tooltip content={view.z > 1 ? "Fit to the window" : "Zoom"} side="bottom">
              <button type="button" className={v.zoom} aria-label={view.z > 1 ? "Fit to the window" : "Zoomed to fit"} onClick={() => zoomTo(1)}>
                {view.z > 1 ? `${String(Math.round(view.z * 100))}%` : "Fit"}
              </button>
            </Tooltip>
            <Tooltip content="Zoom in" side="bottom">
              <Button variant="quiet" iconOnly aria-label="Zoom in" disabled={view.z >= MAX_ZOOM} onClick={() => zoomTo(view.z * STEP_ZOOM)}>
                <Plus />
              </Button>
            </Tooltip>
            <span className={v.gap} aria-hidden />
            <Tooltip content="Copy image" side="bottom">
              <Button variant="quiet" iconOnly aria-label="Copy image" disabled={picture.busy} onClick={() => void picture.copy()}>
                <Copy />
              </Button>
            </Tooltip>
            <Tooltip content="Save to Downloads" side="bottom">
              <Button variant="quiet" iconOnly aria-label={name === undefined ? "Save image" : `Save ${name}`} disabled={picture.busy} onClick={() => void picture.download()}>
                <Download />
              </Button>
            </Tooltip>
          </div>
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
