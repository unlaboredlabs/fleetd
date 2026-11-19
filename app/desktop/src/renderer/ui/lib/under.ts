// The app under a modal that blurs it (Settings, New bot): out of reach of Tab, clicks and screen readers (inert), and
// blurred itself, evenly, the Mac's see-through sidebar too (base.css [data-under-modal]). A backdrop filter on the
// modal's scrim can't do that: it draws a blurred copy over what is under it, see-through where the window is (the
// sidebar), so the crisp words there show through it (F1101). A ref on the modal's outermost element (its scrim):
// what comes before it, at every level up to the body, is held until it goes. One already inert stays as it was.
// What stays over modals ([data-over-modal]: the toasts) is never held: an element holding one is held child by child
// around it, since a filter on it would trap the toasts under the scrim, blurred and out of reach.
export function underModal(top: Element | null): (() => void) | undefined {
  if (top === null) return undefined;
  const held: Element[] = [];
  const hold = (el: Element) => {
    if (el.hasAttribute("data-over-modal")) return;
    if (el.querySelector("[data-over-modal]") !== null) {
      for (const child of el.children) hold(child);
      return;
    }
    if (el.hasAttribute("inert")) return;
    el.setAttribute("inert", "");
    el.setAttribute("data-under-modal", "");
    held.push(el);
  };
  for (let at: Element | null = top; at !== null && at !== document.body; at = at.parentElement) {
    for (let el = at.previousElementSibling; el !== null; el = el.previousElementSibling) hold(el);
  }
  return () => {
    for (const el of held) {
      el.removeAttribute("inert");
      el.removeAttribute("data-under-modal");
    }
  };
}
