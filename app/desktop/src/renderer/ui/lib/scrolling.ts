// A scroller's thumb shows only while it scrolls, and fades a moment after (base.css), as macOS's overlay scrollbars
// do: one listener for the whole page marks whatever scrolls with data-scrolling.

const SHOWN_MS = 900;

/** Marks each element under `root` that scrolls with data-scrolling until SHOWN_MS after its last scroll. */
export function followScrolling(root: Document | HTMLElement = document): () => void {
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  const on = (e: Event) => {
    const target = e.target instanceof HTMLElement ? e.target : e.target === document ? document.scrollingElement : null;
    if (target === null) return;
    target.setAttribute("data-scrolling", "");
    clearTimeout(timers.get(target));
    timers.set(
      target,
      setTimeout(() => {
        target.removeAttribute("data-scrolling");
        timers.delete(target);
      }, SHOWN_MS),
    );
  };
  root.addEventListener("scroll", on, { capture: true, passive: true });
  return () => {
    root.removeEventListener("scroll", on, { capture: true });
    timers.forEach((t) => clearTimeout(t));
  };
}
