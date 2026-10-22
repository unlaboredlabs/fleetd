// Settings → Agents at #/settings/agents?for=<machine>/<project> (the palette's "Max agents" on a project): that
// project's slider scrolls into view with focus, so the arrow keys change its own limit at once.
import { useEffect } from "react";
import { parseRoute, useHash } from "./route";

/** Call from the Agents page; `ready` once the sliders are drawn. */
export function useFocusProjectSlider(ready: boolean) {
  const target = parseRoute(useHash()).for;
  useEffect(() => {
    if (!ready || target === null) return;
    const at = target.indexOf("/");
    if (at < 0) return;
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
