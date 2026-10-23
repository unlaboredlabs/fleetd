// Whether the sidebar shows. Below NARROW_PX it hides itself so the chat keeps its width in a small window; the
// toggle (⌘B) still shows it there, until the window is narrowed again. Above it, it shows unless you hid it.
import { useCallback, useEffect, useState } from "react";

export const NARROW_PX = 1000;

export interface SidebarState {
  readonly narrow: boolean;
  /** Hidden with the toggle while the window was wide. */
  readonly hiddenWide: boolean;
  /** Shown with the toggle while the window was narrow. */
  readonly shownNarrow: boolean;
}

export const sidebarHidden = (s: SidebarState): boolean => (s.narrow ? !s.shownNarrow : s.hiddenWide);

export const toggled = (s: SidebarState): SidebarState =>
  s.narrow ? { ...s, shownNarrow: !s.shownNarrow } : { ...s, hiddenWide: !s.hiddenWide };

/** Narrowing hides it again, whatever was shown narrow before; widening goes back to your wide choice. */
export const resized = (s: SidebarState, narrow: boolean): SidebarState => (narrow === s.narrow ? s : { ...s, narrow, shownNarrow: false });

const narrowQuery = () => window.matchMedia(`(max-width: ${String(NARROW_PX - 1)}px)`);

/** The sidebar's visibility and its toggle. A media query, not a resize listener: it fires only when the width crosses. */
export function useSidebar(): { hidden: boolean; toggle: () => void } {
  const [state, setState] = useState<SidebarState>(() => ({ narrow: narrowQuery().matches, hiddenWide: false, shownNarrow: false }));
  useEffect(() => {
    const query = narrowQuery();
    const onChange = () => setState((s) => resized(s, query.matches));
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const toggle = useCallback(() => setState(toggled), []);
  return { hidden: sidebarHidden(state), toggle };
}
