// The sidebar: the projects first (alphabetical, so none moves), each opening its lead chat and saying why it wants
// you ("reply", "approve", "secret", "blocked") or how many agents work; a chat with a message you haven't seen is
// bold. Then Status, Factory, Time, Machines and Settings (a project's agents and PRs are in the panel beside its chat); then
// any update to make, and the hub (HubStatus). Holding ⌘ (Ctrl) shows jump numbers
// on the first nine projects, which ⌘1..9 open. A project's right-click menu opens it or its settings, copies its
// path, or removes it (RemoveProjectDialog asks first).
import { Activity, Clock, Factory, Plus, Server, Settings } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { HubState } from "../../../shared/hub";
import { display, type ShortcutId } from "../../../shared/shortcuts";
import {
  Button,
  ContextMenu,
  ContextMenuCopy,
  ContextMenuItem,
  ContextMenuSeparator,
  designPick,
  Dot,
  Kbd,
  Sidebar as Frame,
  SidebarItem,
  SidebarSection,
  StateGlyph,
  Text,
  Tooltip,
} from "../../ui";
import { RemoveProjectDialog, type RemoveTarget } from "../projects/RemoveProjectDialog";
import { UpdatesLine } from "../updates";
import { HubStatus } from "./HubStatus";
import { routeOf, type SidebarProject } from "./model";
import { useOfflineAsOf } from "./offline";
import { sameProject, type Screen } from "./routes";
import s from "./shell.module.css";

const platform = window.fleetd.platform;

const kbd = (id: ShortcutId): ReactNode => <Kbd>{display(id, platform)}</Kbd>;

export interface SidebarProps {
  readonly projects: ReadonlyArray<SidebarProject> | undefined;
  /** Machines not online; undefined until known. */
  readonly machinesDown: number | undefined;
  readonly screen: Screen;
  readonly hub: HubState;
  /** ⌘ (Ctrl) is held: show the jump numbers. */
  readonly jumpHints: boolean;
  /** The hub reports metrics (or hasn't said yet): show the Factory. */
  readonly factory: boolean;
  readonly go: (screen: Screen) => void;
}

const UNREAD = "New message from the lead";

/** The row's one mark: why it wants you, else a new message, else how many agents work. */
const mark = (p: SidebarProject): { readonly node: ReactNode; readonly tip: string } | null => {
  const want = p.want;
  if (want !== undefined) {
    if (want.word === "blocked") {
      return { node: <Text size="xs" tone="danger">blocked</Text>, tip: want.label };
    }
    return {
      node: (
        <>
          <Dot color="var(--warning)" />
          {want.word === undefined ? null : (
            <Text size="xs" tone="warning">
              {want.word}
            </Text>
          )}
          {want.count > 1 ? <span>{`· ${String(want.count)}`}</span> : null}
        </>
      ),
      tip: want.label,
    };
  }
  if (p.unread) return { node: <Dot color="var(--accent)" label={UNREAD} />, tip: UNREAD };
  if (p.running > 0) {
    return {
      node: (
        <>
          <StateGlyph state="working" size="sm" />
          {String(p.running)}
        </>
      ),
      tip: `${String(p.running)} ${p.running === 1 ? "agent" : "agents"} working`,
    };
  }
  if (p.working) return { node: <StateGlyph state="thinking" size="sm" />, tip: "The lead is working" };
  return null;
};

/** Offline the marks are the last known ones, and their words say since when (`asOf`, "as of 09:02"). */
const trailing = (p: SidebarProject, jump: number | null, asOf: string | undefined): ReactNode => {
  const m = mark(p);
  const tip = m === null || asOf === undefined ? m?.tip : `${m.tip}, ${asOf}`;
  return (
    <>
      {m === null ? null : (
        <Tooltip content={tip}>
          <span className={s.mark} aria-label={tip}>
            {m.node}
          </span>
        </Tooltip>
      )}
      {jump !== null ? <span className={s.jump}>{jump}</span> : null}
    </>
  );
};

export function Sidebar({ projects, machinesDown, screen, hub, jumpHints, factory, go }: SidebarProps) {
  const asOf = useOfflineAsOf();
  const nav = (label: string, icon: ReactNode, target: Screen, current: boolean, trailing?: ReactNode) => (
    <SidebarItem label={label} icon={icon} current={current} trailing={trailing} onClick={() => go(target)} />
  );
  const open = screen.id === "project" ? screen.project : null;
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);
  const menu = (p: SidebarProject) => () => {
    const { machineId, projectId, title, workspaceRoot } = p.project;
    return (
      <>
        <ContextMenuItem onSelect={() => go({ id: "project", project: routeOf(p), message: null })}>Open</ContextMenuItem>
        <ContextMenuItem onSelect={() => go({ id: "settings", tab: "projects", for: p.key })}>Open settings</ContextMenuItem>
        <ContextMenuCopy text={workspaceRoot}>Copy path</ContextMenuCopy>
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={() => setRemoving({ machineId, projectId, title, path: workspaceRoot })}>
          Remove project…
        </ContextMenuItem>
      </>
    );
  };

  return (
    <Frame
      aria-label="Sidebar"
      footer={
        // W42 design preview: A, the hub and any update on one row; B, a small card with the update above the hub.
        designPick("footer") === "b" ? (
          <div className={s.footerCard}>
            <UpdatesLine variant="banner" />
            <HubStatus hub={hub} variant="card" />
          </div>
        ) : (
          <div className={s.footerRow}>
            <HubStatus hub={hub} variant="row" />
            <UpdatesLine variant="pill" />
          </div>
        )
      }
    >
      <SidebarSection
        title={asOf === undefined ? "Projects" : `Projects, ${asOf}`}
        action={
          <Button variant="quiet" size="sm" icon={<Plus />} onClick={() => go({ id: "projects.add" })}>
            Add
          </Button>
        }
      >
        {projects === undefined ? (
          // Loading (startup, or a resync after the link dropped): never the "no projects" sentence, never old rows.
          // Busy only while something is on its way, not while the hub is unreachable.
          <div className={s.sidebarSkeleton} aria-busy={hub.phase === "live" || hub.phase === "connecting"} aria-label="Loading projects">
            <span />
            <span />
            <span />
          </div>
        ) : projects.length === 0 ? (
          <Text as="p" size="xs" tone="quiet" className={s.sidebarNote}>
            No projects yet. Add one: a GitHub repo, or a folder on one of your machines.
          </Text>
        ) : (
          projects.map((p, i) => (
            <ContextMenu key={p.key} menu={menu(p)}>
              <SidebarItem
                label={p.project.title}
                current={sameProject(open, p.project)}
                emphasis={p.unread}
                trailing={trailing(p, jumpHints && i < 9 ? i + 1 : null, asOf)}
                onClick={() => go({ id: "project", project: routeOf(p), message: null })}
              />
            </ContextMenu>
          ))
        )}
      </SidebarSection>

      <SidebarSection>
        {nav("Status", <Activity />, { id: "status" }, screen.id === "status", kbd("status.toggle"))}
        {factory ? nav("Factory", <Factory />, { id: "factory", project: null }, screen.id === "factory", kbd("factory.open")) : null}
        {nav("Time", <Clock />, { id: "time", orderId: null }, screen.id === "time")}
        {nav(
          "Machines",
          <Server />,
          { id: "machines" },
          screen.id === "machines",
          machinesDown !== undefined && machinesDown > 0 ? <Text size="xs" tone="warning">{`${String(machinesDown)} down`}</Text> : undefined,
        )}
        {/* Settings' Back returns focus here when this opened it. */}
        <SidebarItem
          label="Settings"
          icon={<Settings />}
          current={screen.id === "settings"}
          trailing={kbd("settings.open")}
          data-opens="settings"
          onClick={() => go({ id: "settings", tab: "general" })}
        />
      </SidebarSection>
      <RemoveProjectDialog project={removing} onClose={() => setRemoving(null)} />
    </Frame>
  );
}
