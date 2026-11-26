// A PDF's pages, one under another at the panel's width (or zoomed), each drawn once it scrolls near: its picture at
// the screen's density and its text over it, so words select and copy. The line under the pages says which page is
// in view and holds the zoom.
import { Minus, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Text, Tooltip } from "../../ui";
import type { FileSource } from "./source";
import f from "./files.module.css";

import type * as PdfModule from "./pdf";

type Pdf = typeof PdfModule;
type Doc = Awaited<ReturnType<Pdf["openPdf"]>["doc"]>;

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
/** Room on each side of a page. */
const SIDE = 16;

export function PdfView({ source, size, first }: { source: FileSource; size: number; first: Uint8Array }) {
  const [state, setState] = useState<{ pdf: Pdf; doc: Doc; aspect: number } | { error: string } | undefined>(undefined);
  const [zoom, setZoom] = useState<number>(1);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(1);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    let close: () => void = () => undefined;
    void import("./pdf")
      .then(async (pdf) => {
        const opened = pdf.openPdf(source, size, first);
        close = opened.close;
        const doc = await opened.doc;
        const one = await doc.getPage(1);
        const v = one.getViewport({ scale: 1 });
        if (live) setState({ pdf, doc, aspect: v.height / v.width });
      })
      .catch((e: unknown) => live && setState({ error: e instanceof Error && e.name === "PasswordException" ? "This PDF has a password." : "This PDF couldn’t be read." }));
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
  return (
    <div className={f.table}>
      <div ref={box} className={f.pdf} onScroll={(e) => setPage(pageInView(e.currentTarget, pages))}>
        {state === undefined ? (
          <div className={f.pdfPage} style={{ width: fit, height: Math.round(fit * 1.294) }} aria-busy="true" />
        ) : "error" in state ? (
          <Text size="sm" tone="quiet" className={f.pdfNote}>
            {state.error}
          </Text>
        ) : (
          Array.from({ length: pages }, (_, i) => <Page key={i} pdf={state.pdf} doc={state.doc} n={i + 1} width={pageWidth} aspect={state.aspect} />)
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

function Page({ pdf, doc, n, width, aspect }: { pdf: Pdf; doc: Doc; n: number; width: number; aspect: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(n === 1);
  const [shape, setShape] = useState(aspect);

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
      await Promise.all([task.promise, layer.render()]).catch(() => undefined);
    });
    return () => {
      live = false;
      cancel();
    };
  }, [near, width, doc, n, pdf]);

  return (
    <div ref={holder} className={f.pdfPage} data-page={n} style={{ width, height: Math.round(width * shape) }}>
      <canvas ref={canvas} className={f.pdfCanvas} aria-label={`Page ${String(n)}`} />
      <div ref={text} className={f.pdfText} />
    </div>
  );
}
