// The panel beside a project's chat, as the frame holds it. Whether it shows is the window's (sidebarState: it hides
// itself in a narrow window, like the sidebar); what it shows is the route's when the route names a view (a PR link,
// Status's PRs, the palette), else the tab you last had. Its contents load with its first opening, and while it is
// closed nothing in it reads from the hub.
import { PanelRight } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { display } from "../../../shared/shortcuts";
import { Boundary } from "../../src/Boundary";
import { Button } from "../../ui";
import { navigate } from "./navigation";
import { panelRoute, type PanelView, type ProjectKey, type Screen } from "./routes";
import { usePanel } from "./sidebarState";
import s from "./shell.module.css";

const ProjectPanel = lazy(() => import("../panel/ProjectPanel").then((m) => ({ default: m.ProjectPanel })));

const LIST: Readonly<Record<PanelView["tab"], PanelView>> = { agents: { tab: "agents", agent: null }, prs: { tab: "prs", pr: null } };

export interface ProjectPanelState {
  /** The project on screen; the panel is only ever beside a project's chat. */
  readonly project: ProjectKey | null;
  readonly shown: boolean;
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
  const was = useRef(shown);
  useEffect(() => {
    const closed = was.current && !shown;
    was.current = shown;
    if (closed && screen.id === "project" && screen.panel !== undefined) navigate({ id: "project", project: screen.project, message: screen.message }, { replace: true });
  }, [shown, screen]);

  return { project, shown, view: routed ?? LIST[panel.tab], toggle: panel.toggle };
}

/** The top row's toggle, beside a project's chat only. */
export function PanelToggle({ panel }: { panel: ProjectPanelState }) {
  if (panel.project === null) return null;
  const verb = panel.shown ? "Hide" : "Show";
  return (
    <Button
      variant="quiet"
      iconOnly
      aria-label={`${verb} agents and PRs`}
      title={`${verb} agents and PRs (${display("panel.toggle", window.fleetd.platform)})`}
      aria-pressed={panel.shown}
      data-opens="panel"
      onClick={panel.toggle}
    >
      <PanelRight />
    </Button>
  );
}

/**
 * The panel itself, while it shows. Esc inside it goes back from an agent or a PR to the list, then closes it and
 * returns focus to the toggle; menus and dialogs in it take their own Esc first.
 */
export function PanelSlot({ panel }: { panel: ProjectPanelState }) {
  const { project, view } = panel;
  if (!panel.shown || project === null) return null;
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') !== null) return;
    e.preventDefault();
    if (view.tab === "agents" ? view.agent !== null : view.pr !== null) {
      // Focus stays in the panel as the item leaves, so a second Esc closes it.
      e.currentTarget.focus();
      navigate(panelRoute(project, LIST[view.tab]));
      return;
    }
    panel.toggle();
    document.querySelector<HTMLElement>('[data-opens="panel"]')?.focus();
  };
  return (
    <aside className={s.panel} aria-label="Agents and pull requests" tabIndex={-1} onKeyDown={onKeyDown}>
      <Boundary key="panel" part="the panel">
        <Suspense fallback={<div className={s.panelLoading} aria-busy="true" />}>
          <ProjectPanel project={project} view={view} />
        </Suspense>
      </Boundary>
    </aside>
  );
}
