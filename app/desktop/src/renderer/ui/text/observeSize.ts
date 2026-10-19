/**
 * One ResizeObserver shared by every truncating element, so a long list costs one observer, not one each. A box
 * keeps its size when its font finishes loading, so a font load re-measures everything too.
 */
type Callback = () => void;

const live = new Map<Element, Callback>();
let observer: ResizeObserver | null = null;

function remeasureAll() {
  for (const cb of live.values()) cb();
}

export function observeSize(el: Element, cb: Callback): () => void {
  if (!observer) {
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) live.get(entry.target)?.();
    });
    // happy-dom and old engines have no FontFaceSet; there, sizes settle with the first measure.
    if ("fonts" in document) document.fonts.addEventListener("loadingdone", remeasureAll);
  }
  live.set(el, cb);
  observer.observe(el);
  return () => {
    live.delete(el);
    observer?.unobserve(el);
  };
}

/** Whether the element's text is cut: wider than its box (one line) or taller (clamped lines). */
export function isCut(el: HTMLElement): boolean {
  return el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 1;
}
