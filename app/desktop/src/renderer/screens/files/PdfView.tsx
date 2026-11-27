// A PDF's pages, one under another at the panel's width (or zoomed), each drawn once it scrolls near: its picture at
// the screen's density and its text over it, so words select and copy. The line under the pages says which page is
// in view and holds the zoom. A page that can't be shown (it won't draw, its pictures didn't decode, a part of it the
// workspace couldn't send) says so in its own place, with Try again, and the other pages stay; a PDF that won't open
// at all (damaged, locked by a password) says so in one line, with Download and, on the desktop, Open in app.
import { Download, ExternalLink, Minus, Plus, RotateCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Text, Tooltip } from "../../ui";
import type { FileSource } from "./source";
import f from "./files.module.css";

import type * as PdfModule from "./pdf";

type Pdf = typeof PdfModule;
type Doc = Awaited<ReturnType<Pdf["openPdf"]>["doc"]>;

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
/** Room on each side of a page. */
const SIDE = 16;

/** Why a PDF or one of its pages isn't shown, in a line. */
const NOT_SHOWN = "This PDF couldn’t be shown here.";
const PAGE_NOT_SHOWN = "This page couldn’t be shown.";
const LOCKED = "This PDF has a password, so it can’t be shown here.";

export function PdfView(props: { source: FileSource; size: number; first: Uint8Array; onDownload: () => void; onOpenInApp: (() => void) | undefined }) {
  const { source, size, first, onDownload, onOpenInApp } = props;
  const [state, setState] = useState<{ pdf: Pdf; doc: Doc; aspect: number } | { error: string } | undefined>(undefined);
  // A part of the file the workspace couldn't send: the pages waiting on it say so, the others stay.
  const [missing, setMissing] = useState(false);
  const retryRanges = useRef<() => void>(() => undefined);
  const again = useCallback(() => {
    setMissing(false);
    retryRanges.current();
  }, []);
  const [zoom, setZoom] = useState<number>(1);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(1);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    let close: () => void = () => undefined;
    void import("./pdf")
      .then(async (pdf) => {
        const opened = pdf.openPdf(source, size, first, () => live && setMissing(true));
        close = opened.close;
        retryRanges.current = opened.retry;
        const doc = await opened.doc;
        const one = await doc.getPage(1);
        const v = one.getViewport({ scale: 1 });
        if (live) setState({ pdf, doc, aspect: v.height / v.width });
      })
      .catch((e: unknown) => live && setState({ error: e instanceof Error && e.name === "PasswordException" ? LOCKED : NOT_SHOWN }));
    return () => {
      live = false;
      close();
    };
  }, [source, size, first]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    const seen = new ResizeObserver(() => setWidth(el.clientWidth));
    seen.observe(el);
    setWidth(el.clientWidth);
    return () => seen.disconnect();
  }, []);

  const fit = Math.max(200, width - 2 * SIDE);
  const pageWidth = Math.round(fit * zoom);
  const ready = state !== undefined && "doc" in state ? state : undefined;
  const pages = ready?.doc.numPages ?? 0;
  const at = ZOOMS.indexOf(zoom as (typeof ZOOMS)[number]);
  // The whole view says it only when the file won't open: damaged, locked, or its opening part never came.
  const unopened = state === undefined && missing;
  const error = unopened ? NOT_SHOWN : state !== undefined && "error" in state ? state.error : undefined;
  if (error !== undefined) {
    return (
      <div className={f.table}>
        <div className={f.pdfFailed} role="alert" data-pdf="failed">
          <Text size="sm">{error}</Text>
          <span className={f.pdfFailedActions}>
            {unopened ? (
              <Button variant="secondary" icon={<RotateCw aria-hidden />} onClick={again}>
                Try again
              </Button>
            ) : null}
            <Button variant="secondary" icon={<Download aria-hidden />} onClick={onDownload}>
              Download
            </Button>
            {onOpenInApp !== undefined ? (
              <Button variant="secondary" icon={<ExternalLink aria-hidden />} onClick={onOpenInApp}>
                Open in app
              </Button>
            ) : null}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className={f.table}>
      <div ref={box} className={f.pdf} onScroll={(e) => setPage(pageInView(e.currentTarget, pages))}>
        {ready === undefined ? (
          <div className={f.pdfPage} style={{ width: fit, height: Math.round(fit * 1.294) }} aria-busy="true" />
        ) : (
          Array.from({ length: pages }, (_, i) => <Page key={i} pdf={ready.pdf} doc={ready.doc} n={i + 1} width={pageWidth} aspect={ready.aspect} missing={missing} onAgain={again} />)
        )}
      </div>
      <div className={f.status}>
        <Text size="xs" tone="quiet" tabular>
          {pages === 0 ? "PDF" : `Page ${String(page)} of ${String(pages)}`}
        </Text>
        <span className={f.zoom}>
          <Tooltip content="Zoom out">
            <Button size="sm" variant="quiet" iconOnly aria-label="Zoom out" disabled={at <= 0} onClick={() => setZoom(ZOOMS[at - 1] ?? zoom)}>
              <Minus />
            </Button>
          </Tooltip>
          <Tooltip content="Fit to width">
            <button type="button" className={f.zoomValue} onClick={() => setZoom(1)}>
              {`${String(Math.round(zoom * 100))}%`}
            </button>
          </Tooltip>
          <Tooltip content="Zoom in">
            <Button size="sm" variant="quiet" iconOnly aria-label="Zoom in" disabled={at >= ZOOMS.length - 1} onClick={() => setZoom(ZOOMS[at + 1] ?? zoom)}>
              <Plus />
            </Button>
          </Tooltip>
        </span>
      </div>
    </div>
  );
}

/** The page whose middle is nearest the view's top third. */
const pageInView = (el: HTMLElement, pages: number): number => {
  const line = el.getBoundingClientRect().top + el.clientHeight / 3;
  let best = 1;
  for (const p of el.querySelectorAll<HTMLElement>("[data-page]")) {
    if (p.getBoundingClientRect().top <= line) best = Number(p.dataset.page);
  }
  return Math.min(Math.max(1, best), Math.max(1, pages));
};

/** A draw stopped because the page moved on (zoom, scroll away), not because it failed. */
const cancelled = (e: unknown) => e instanceof Error && e.name === "RenderingCancelledException";

/**
 * One page: drawn once it scrolls near. One that fails to draw, draws blank for its pictures, or waits on a part the
 * workspace couldn't send shows a note in its place, with Try again: a draw again, or the missing part asked for again.
 */
function Page(props: { pdf: Pdf; doc: Doc; n: number; width: number; aspect: number; missing: boolean; onAgain: () => void }) {
  const { pdf, doc, n, width, aspect, missing, onAgain } = props;
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(n === 1);
  const [shape, setShape] = useState(aspect);
  // A Try again on a page that failed to draw: draw it again.
  const [tries, setTries] = useState(0);
  // How the draw went, of the draw it was: a new width or a Try again starts as drawing.
  const attempt = `${String(width)}:${String(tries)}`;
  const [ended, setEnded] = useState<{ readonly attempt: string; readonly phase: "drawn" | "failed" } | undefined>(undefined);
  const phase = ended?.attempt === attempt ? ended.phase : "drawing";

  useEffect(() => {
    const el = holder.current;
    if (el === null || near) return;
    const seen = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setNear(true), { rootMargin: "600px 0px" });
    seen.observe(el);
    return () => seen.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near || width <= 0) return;
    let live = true;
    let cancel: () => void = () => undefined;
    const failed = (e: unknown) => {
      if (live && !cancelled(e)) setEnded({ attempt, phase: "failed" });
    };
    void doc.getPage(n).then(async (p) => {
      const base = p.getViewport({ scale: 1 });
      const scale = width / base.width;
      const viewport = p.getViewport({ scale });
      if (!live) return;
      setShape(base.height / base.width);
      const c = canvas.current;
      const t = text.current;
      if (c === null || t === null) return;
      const density = window.devicePixelRatio || 1;
      c.width = Math.floor(viewport.width * density);
      c.height = Math.floor(viewport.height * density);
      const task = p.render({ canvas: c, viewport, transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0] });
      t.replaceChildren();
      t.style.setProperty("--total-scale-factor", String(scale));
      const layer = new pdf.TextLayer({ textContentSource: p.streamTextContent(), container: t, viewport });
      cancel = () => {
        task.cancel();
        layer.cancel();
      };
      // The picture failing is the page failing, as is a page left blank by pictures that didn't decode; its words
      // failing only leaves them unselectable.
      const drawn = task.promise.then(
        async () => {
          if (await pdf.drewBlank(p)) failed(new Error("The page's pictures couldn't be decoded."));
          else if (live) setEnded({ attempt, phase: "drawn" });
        },
        failed,
      );
      await Promise.all([drawn.catch(() => undefined), layer.render().catch(() => undefined)]);
    }, failed);
    return () => {
      live = false;
      cancel();
    };
  }, [near, width, doc, n, pdf, attempt]);

  // A page still drawing while a part of the file didn't come is waiting on it.
  const shown = phase === "failed" || (phase === "drawing" && near && missing) ? "failed" : phase;
  return (
    <div ref={holder} className={f.pdfPage} data-page={n} data-state={shown} style={{ width, height: Math.round(width * shape) }}>
      <canvas ref={canvas} className={f.pdfCanvas} aria-label={`Page ${String(n)}`} />
      <div ref={text} className={f.pdfText} />
      {shown === "failed" ? (
        <div className={f.pdfPageNote} role="alert">
          <Text size="sm" tone="quiet">
            {PAGE_NOT_SHOWN}
          </Text>
          <Button size="sm" variant="secondary" icon={<RotateCw aria-hidden />} onClick={() => (phase === "failed" ? setTries((x) => x + 1) : onAgain())}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
