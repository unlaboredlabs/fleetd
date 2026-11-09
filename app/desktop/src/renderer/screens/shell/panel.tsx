// The panel beside a project's chat, as the frame holds it. Whether it shows is the window's (sidebarState: it hides
// itself in a narrow window, like the sidebar); what it shows is the route's when the route names a view (a PR link,
// Status's PRs, the palette), else the tab you last had. Its width is yours (panelWidth.ts): drag its left edge, or
// focus that edge and use the arrow keys; a double-click resets it. The frame slides it in as its toggle opens it and
// out as it closes it (AppFrame), only by transform, so the chat beside it never lays out again mid-way; leaving the
// project's chat takes it away at once. Its contents load with its first opening, and once it has gone nothing in it
// reads from the hub.
import { PanelRight } from "lucide-react";
import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { display } from "../../../shared/shortcuts";
import { Boundary } from "../../src/Boundary";
import { Button } from "../../ui";
import { navigate } from "./navigation";
import { ResizeEdge } from "./ResizeEdge";
import { shownWidth, usePanelWidths, useWindowWidth, widthBounds, type PanelMode } from "./panelWidth";
import { hasItem, listView, panelRoute, type PanelView, type ProjectKey, type Screen } from "./routes";
import { usePanel } from "./sidebarState";
import s from "./shell.module.css";

const ProjectPanel = memo(lazy(() => import("../panel/ProjectPanel").then((m) => ({ default: m.ProjectPanel }))));

export const PANEL_LABEL = "Project panel";

export interface ProjectPanelState {
  /** The project on screen; the panel is only ever beside a project's chat. */
  readonly project: ProjectKey | null;
  readonly shown: boolean;
  /** Open by its toggle, whether or not a project's chat is on screen to show it beside: the frame slides it as this
   * changes, and only then. */
  readonly open: boolean;
  readonly view: PanelView;
  readonly toggle: () => void;
}

export function useProjectPanel(screen: Screen): ProjectPanelState {
  const panel = usePanel();
  const project = screen.id === "project" ? screen.project : null;
  const routed = screen.id === "project" ? screen.panel : undefined;
  const shown = project !== null && !panel.hidden;

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

  return { project, shown, open: !panel.hidden, view: routed ?? listView(panel.tab), toggle: panel.toggle };
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

/**
 * The panel itself, while it shows, its max leaving room for the sidebar as wide as it is (`sidebarPx`, 0 without one).
 * Esc inside it goes back from an agent or a PR to the list, then closes it and
 * returns focus to the toggle; menus and dialogs in it take their own Esc first.
 */
export function PanelSlot({ panel, sidebarPx }: { panel: ProjectPanelState; sidebarPx: number }) {
  const { project, view, shown } = panel;
  const aside = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(false);
  const mode: PanelMode = wide ? "wide" : "normal";
  const [widths, setWidth] = usePanelWidths();
  const bounds = widthBounds(mode, useWindowWidth(), sidebarPx);
  const width = shownWidth(widths[mode], bounds);

  if (!shown || project === null) return null;
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
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
      data-mode={mode}
      style={{ "--panel-size": `${String(width)}px` } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <ResizeEdge
        edge="left"
        label="Resize the panel"
        controls="project-panel"
        target={aside}
        variable="--panel-size"
        width={width}
        min={bounds.min}
        max={bounds.max}
        onSet={(w) => setWidth(mode, w)}
      />
      <Boundary key="panel" part="the panel">
        <Suspense fallback={<div className={s.panelLoading} aria-busy="true" />}>
          <ProjectPanel project={project} view={view} onWide={setWide} />
        </Suspense>
      </Boundary>
    </aside>
  );
}
