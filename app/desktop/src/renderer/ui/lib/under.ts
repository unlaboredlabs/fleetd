// The app under a modal that blurs it (Settings, New bot): out of reach of Tab, clicks and screen readers (inert), and
// blurred itself, evenly, the Mac's see-through sidebar too (base.css [data-under-modal]). A backdrop filter on the
// modal's scrim can't do that: it draws a blurred copy over what is under it, see-through where the window is (the
// sidebar), so the crisp words there show through it (F1101). A ref on the modal's outermost element (its scrim):
// what comes before it, at every level up to the body, is held until it goes. One already inert stays as it was.
export function underModal(top: Element | null): (() => void) | undefined {
  if (top === null) return undefined;
  const held: Element[] = [];
  for (let at: Element | null = top; at !== null && at !== document.body; at = at.parentElement) {
    for (let el = at.previousElementSibling; el !== null; el = el.previousElementSibling) {
      if (el.hasAttribute("inert")) continue;
      el.setAttribute("inert", "");
      el.setAttribute("data-under-modal", "");
      held.push(el);
    }
  }
  return () => {
    for (const el of held) {
      el.removeAttribute("inert");
      el.removeAttribute("data-under-modal");
    }
  };
}
