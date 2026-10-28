// The palette's "Max agents for this project" opens Settings → Projects → Agents at #/settings/agents?for=<machine>/<project>
// and asks for its slider: it scrolls into view with focus, so the arrow keys change the project's own limit at once.
// Only that ask focuses it; opening Agents any other way leaves the arrow keys to the page.
import { useEffect } from "react";
import { useSettingsRoute } from "./route";

let wanted = false;

/** The next Agents page to draw its slider focuses it. */
export const focusSliderNext = (): void => {
  wanted = true;
};

/** Call from the Agents page; `ready` once the slider is drawn. */
export function useFocusProjectSlider(ready: boolean) {
  const target = useSettingsRoute().for;
  useEffect(() => {
    if (!ready || target === null || !wanted) return;
    const at = target.indexOf("/");
    if (at < 0) return;
    wanted = false;
    // AgentsPanel names each slider's thumb by `agents-<machine>-<project>-label`.
    const label = `agents-${target.slice(0, at)}-${target.slice(at + 1)}-label`;
    // A frame later: the screen is still hidden behind its lazy load when this first runs, and focus() skips it.
    const frame = requestAnimationFrame(() => {
      const thumb = document.querySelector(`[aria-labelledby="${CSS.escape(label)}"]`);
      if (!(thumb instanceof HTMLElement)) return;
      thumb.scrollIntoView({ block: "center" });
      thumb.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, target]);
}
