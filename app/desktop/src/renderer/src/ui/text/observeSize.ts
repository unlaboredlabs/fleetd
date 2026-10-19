/**
 * One ResizeObserver shared by every truncating element, so a long list costs one observer, not one each.
 */
type Callback = () => void;

const callbacks = new WeakMap<Element, Callback>();
let observer: ResizeObserver | null = null;

export function observeSize(el: Element, cb: Callback): () => void {
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) callbacks.get(entry.target)?.();
  });
  callbacks.set(el, cb);
  observer.observe(el);
  return () => {
    callbacks.delete(el);
    observer?.unobserve(el);
  };
}

/** Whether the element's text is cut: wider than its box (one line) or taller (clamped lines). */
export function isCut(el: HTMLElement): boolean {
  return el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 1;
}
