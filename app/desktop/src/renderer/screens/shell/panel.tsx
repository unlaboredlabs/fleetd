// The panel beside a project's chat, as the frame holds it. Whether it shows is the window's (sidebarState: it hides
// itself in a narrow window, like the sidebar); what it shows is the route's when the route names a view (a PR link,
// Status's PRs, the palette), else the tab you last had. Its width is yours (panelWidth.ts): drag its left edge, or
// focus that edge and use the arrow keys; a double-click resets it. It slides in as it opens and out as it closes,
// only by transform and opacity, so the chat beside it never lays out again mid-way. Its contents load with its first
// opening, and once it has closed nothing in it reads from the hub.
import { PanelRight } from "lucide-react";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { display } from "../../../shared/shortcuts";
import { Boundary } from "../../src/Boundary";
import { Button } from "../../ui";
import { navigate } from "./navigation";
import { keyedWidth, shownWidth, usePanelWidths, useWindowWidth, widthBounds, type PanelMode } from "./panelWidth";
import { hasItem, listView, panelRoute, type PanelView, type ProjectKey, type Screen } from "./routes";
import { usePanel } from "./sidebarState";
import s from "./shell.module.css";

const ProjectPanel = memo(lazy(() => import("../panel/ProjectPanel").then((m) => ({ default: m.ProjectPanel }))));

export const PANEL_LABEL = "Project panel";

export interface ProjectPanelState {
  /** The project on screen; the panel is only ever beside a project's chat. */
  readonly project: ProjectKey | null;
  readonly shown: boolean;
  /** Shown, or sliding out after it closed: the frame keeps it until it is gone. */
  readonly present: boolean;
  readonly view: PanelView;
  readonly toggle: () => void;
  /** Its slide out ended. */
  readonly gone: () => void;
}

export function useProjectPanel(screen: Screen): ProjectPanelState {
  const panel = usePanel();
  const project = screen.id === "project" ? screen.project : null;
  const routed = screen.id === "project" ? screen.panel : undefined;
  const shown = project !== null && !panel.hidden;

  // Closing starts its slide out in the same render, so it never vanishes for a frame first. Leaving the project's
  // chat takes it away at once.
  const [was, setWas] = useState(shown);
  const [closing, setClosing] = useState(false);
  if (was !== shown) {
    setWas(shown);
    setClosing(!shown && project !== null);
  }
  const gone = useCallback(() => setClosing(false), []);

  // A route that names a view opens the panel on it before paint, so a link never shows it closed first.
  const routedKey = routed === undefined ? null : JSON.stringify(routed);
  const routedTab = routed?.tab;
  const { show } = panel;
  useLayoutEffect(() => {
    if (routedTab !== undefined) show(routedTab);
  }, [routedKey, routedTab, show]);

  // Closing it (the toggle, Esc, a narrowing window) drops the view from the route, so the same link opens it again.
  const wasShown = useRef(shown);
  useEffect(() => {
    const closed = wasShown.current && !shown;
    wasShown.current = shown;
    if (closed && screen.id === "project" && screen.panel !== undefined) navigate({ id: "project", project: screen.project, message: screen.message }, { replace: true });
  }, [shown, screen]);

  return { project, shown, present: shown || (closing && project !== null), view: routed ?? listView(panel.tab), toggle: panel.toggle, gone };
}

/** The top row's toggle, beside a project's chat only. */
export function PanelToggle({ panel }: { panel: ProjectPanelState }) {
  if (panel.project === null) return null;
  const verb = panel.shown ? "Hide" : "Show";
  return (
    <Button
      variant="quiet"
      iconOnly
      aria-label={`${verb} the panel`}
      title={`${verb} the panel: agents, PRs and the checklist (${display("panel.toggle", window.fleetd.platform)})`}
      aria-pressed={panel.shown}
      aria-controls={panel.shown ? "project-panel" : undefined}
      data-opens="panel"
      onClick={panel.toggle}
    >
      <PanelRight />
    </Button>
  );
}

/** Whether the element runs a CSS animation now; without one (reduced motion, no styles) its end never comes. */
const animates = (el: HTMLElement): boolean => {
  const style = getComputedStyle(el);
  const names = style.animationName.split(",").map((n) => n.trim());
  const longest = Math.max(0, ...style.animationDuration.split(",").map((d) => (d.trim().endsWith("ms") ? parseFloat(d) : parseFloat(d) * 1000) || 0));
  return names.some((n) => n !== "" && n !== "none") && longest > 0;
};

/**
 * The panel itself, while it shows. Esc inside it goes back from an agent or a PR to the list, then closes it and
 * returns focus to the toggle; menus and dialogs in it take their own Esc first.
 */
export function PanelSlot({ panel }: { panel: ProjectPanelState }) {
  const { project, view, shown, gone } = panel;
  const aside = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(false);
  const mode: PanelMode = wide ? "wide" : "normal";
  const [widths, setWidth] = usePanelWidths();
  const bounds = widthBounds(mode, useWindowWidth());
  const width = shownWidth(widths[mode], bounds);

  // Closed: it slides out, then the frame lets it go. Without an animation to wait for, at once.
  useLayoutEffect(() => {
    if (shown) return;
    const el = aside.current;
    if (el === null || !animates(el)) {
      gone();
      return;
    }
    const late = window.setTimeout(gone, 400);
    return () => window.clearTimeout(late);
  }, [shown, gone]);

  if (!panel.present || project === null) return null;
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || !shown) return;
    if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') !== null) return;
    e.preventDefault();
    if (hasItem(view)) {
      // Focus stays in the panel as the item leaves, so a second Esc closes it.
      e.currentTarget.focus();
      navigate(panelRoute(project, listView(view.tab)));
      return;
    }
    panel.toggle();
    document.querySelector<HTMLElement>('[data-opens="panel"]')?.focus();
  };
  return (
    <aside
      ref={aside}
      id="project-panel"
      className={s.panel}
      aria-label={PANEL_LABEL}
      tabIndex={-1}
      data-state={shown ? "open" : "closed"}
      data-mode={mode}
      inert={!shown}
      style={{ "--panel-size": `${String(width)}px` } as CSSProperties}
      onKeyDown={onKeyDown}
      onAnimationEnd={(e) => {
        if (!shown && e.target === e.currentTarget) gone();
      }}
    >
      <ResizeHandle panel={aside} width={width} min={bounds.min} max={bounds.max} onSet={(w) => setWidth(mode, w)} />
      <Boundary key="panel" part="the panel">
        <Suspense fallback={<div className={s.panelLoading} aria-busy="true" />}>
          <ProjectPanel project={project} view={view} onWide={setWide} />
        </Suspense>
      </Boundary>
    </aside>
  );
}

/**
 * The panel's left edge, a vertical separator: drag it, or focus it and use Left (wider), Right (narrower), Home and
 * End; Shift moves four steps. A double-click (or Enter) puts it back to its default. A drag moves the width on the
 * element itself and sets it once, as it ends, so nothing in the panel renders again per frame.
 */
function ResizeHandle({ panel, width, min, max, onSet }: { panel: RefObject<HTMLElement | null>; width: number; min: number; max: number; onSet: (width: number | null) => void }) {
  const drag = useRef<{ x: number; from: number; now: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const live = (px: number) => {
    panel.current?.style.setProperty("--panel-size", `${String(px)}px`);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, from: width, now: width };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null) return;
    d.now = Math.round(Math.min(Math.max(d.from + d.x - e.clientX, min), max));
    live(d.now);
    e.currentTarget.setAttribute("aria-valuenow", String(d.now));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d === null) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.now !== d.from) onSet(d.now);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSet(null);
      return;
    }
    const next = keyedWidth(e.key, e.shiftKey, width, { min, max, initial: width });
    if (next === null) return;
    e.preventDefault();
    // Saved even when it is the width already shown: the default follows the window, what you chose doesn't.
    onSet(next);
  };

  // A drag the window lost (a blur mid-drag) leaves no stray cursor behind.
  useEffect(() => {
    if (!dragging) return;
    document.documentElement.dataset["panelResizing"] = "";
    return () => {
      delete document.documentElement.dataset["panelResizing"];
    };
  }, [dragging]);

  return (
    <div
      className={s.resize}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-controls="project-panel"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${String(width)} pixels wide`}
      title="Drag to resize; double-click to reset"
      tabIndex={0}
      data-dragging={dragging ? "" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => onSet(null)}
      onKeyDown={onKeyDown}
    />
  );
}
