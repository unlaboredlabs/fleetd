// The sidebar: your Navis pinned on top (navi/model.ts), then the projects, each section in your own order: drag a row,
// or move a focused one with ⌥↑ / ⌥↓, and it stays there on each of your desktops (yourOrder.ts; new ones go at the
// end, by title, and nothing moves by itself, so a row never moves under the pointer). Each opens its chat and says
// why it wants you ("reply", "approve", "secret", "blocked") or how many agents work; a chat with a message you haven't
// seen is bold. With no Navi yet, one quiet row offers to meet it (#/navi), with no
// heading. Then three rows: Status, Factory (its Agent time tab too) and Settings, which for an admin says how many
// of the hub's required setup steps are left and opens on them (a project's agents and PRs are in the panel beside
// its chat); then any update to make, and the hub (HubStatus), which
// says how many machines are down and opens Machines. Holding ⌘ (Ctrl) shows jump numbers on the first nine rows, which ⌘1..9 open. A
// project's right-click menu opens it or its settings, copies its path, or removes it (RemoveProjectDialog asks
// first); a Navi's renames or archives it instead (Undo in the toast).
//
// With several hubs (docs/design/hubs.md) the Navis of every hub stay on top, each saying its hub, and each hub's
// projects are a group under its name, which collapses; the footer has a row per hub. With one, there is no name and
// no group, as before.
import { Activity, ChevronDown, ChevronRight, Factory, Plus, Settings, Sparkle } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { display, type ShortcutId } from "../../../shared/shortcuts";
import type { DataLayer } from "../../src/data/queries";
import { HubScope, useDataLayer, useHub, useHubs, useToolQuery } from "../../src/data/react";
import { archiveNavi, RenameNaviDialog, type NaviTarget } from "../navi/actions";
import { isNavi } from "../navi/model";
import {
  Button,
  ContextMenu,
  ContextMenuCopy,
  ContextMenuItem,
  ContextMenuSeparator,
  Dot,
  Kbd,
  Sidebar as Frame,
  SidebarItem,
  SidebarSection,
  StateGlyph,
  Text,
  Tooltip,
  Truncate,
  useReorder,
} from "../../ui";
import { ProjectAvatar } from "../projects/ProjectAvatar";
import { RemoveProjectDialog, type RemoveTarget } from "../projects/RemoveProjectDialog";
import { UpdatesLine } from "../updates";
import { HubStatus } from "./HubStatus";
import { useHubState } from "./hubFeed";
import { useHubRows } from "./hubRows";
import { HUB_COLOR } from "./hubColor";
import { HubText } from "../projects/HubText";
import { routeOf, type SidebarProject } from "./model";
import type { Routed } from "./navigation";
import { useOfflineAsOf } from "./offline";
import { sameProject, type ProjectKey, type Screen } from "./routes";
import type { Placed } from "./Shell";
import { shownRows } from "./sidebarState";
import { saveOrder, withMoved } from "./yourOrder";
import s from "./shell.module.css";

const platform = window.fleetd.platform;
/** A project's or Navi's icon in its tall row (SidebarItem `tall`): big enough to enjoy its glass face, the row 48 px around it. */
const SIDEBAR_AVATAR = 36;

const kbd = (id: ShortcutId): ReactNode => <Kbd>{display(id, platform)}</Kbd>;

export interface SidebarProps {
  /** Every hub's rows, in sidebar order; undefined while the screen's hub's are loading. */
  readonly projects: ReadonlyArray<Placed> | undefined;
  readonly screen: Routed;
  /** ⌘ (Ctrl) is held: show the jump numbers. */
  readonly jumpHints: boolean;
  /** The hub groups collapsed, by hub id (the frame keeps them: ⌘1–9 count only the rows on show). */
  readonly collapsed: ReadonlySet<string>;
  readonly onToggleHub: (hub: string) => void;
  /** The hub reports metrics (or hasn't said yet): the Factory opens on Output, else on Agent time. */
  readonly factory: boolean;
  /** This app's person is an owner or admin: Settings says what of the hub's setup is left, to nobody else. */
  readonly admin: boolean;
  readonly go: (screen: Screen) => void;
}

const UNREAD = "New message from the lead";

/** Saves `hub`'s order with `moved` (keys of one section, in their new order), from its rows among `all`. */
const save = (layer: DataLayer | undefined, all: ReadonlyArray<Placed>, hub: string, moved: readonly string[]) => {
  if (layer === undefined) return;
  void saveOrder(layer, withMoved(all.filter((p) => p.hub === hub), moved).map(routeOf));
};

/** The rows of a section by key, for drawing them in the order the reorder shows. */
const byKey = (rows: ReadonlyArray<Placed>): ReadonlyMap<string, Placed> => new Map(rows.map((p) => [p.key, p]));

const noInput = {};

/**
 * Settings' entry. For an owner or admin, while the hub's setup has a required step left, it says how many and opens on
 * Hub › Setup; a hub from before setup steps says nothing. Settings' Back returns focus here when this opened it.
 */
function SettingsEntry({ current, admin, trailing, go }: { current: boolean; admin: boolean; trailing: ReactNode; go: (screen: Screen) => void }) {
  const setup = useToolQuery("setup_list", noInput, { enabled: admin });
  const left = admin ? (setup.data?.requiredLeft ?? 0) : 0;
  return (
    <SidebarItem
      label="Settings"
      icon={<Settings />}
      current={current}
      data-opens="settings"
      trailing={left > 0 ? <Text size="xs" tone="warning">{`${String(left)} left`}</Text> : trailing}
      onClick={() => go({ id: "settings", tab: left > 0 ? "hub.setup" : "general" })}
    />
  );
}

/** The row's one mark: why it wants you, else a new message, else a red main, else how many agents work. */
const mark = (p: SidebarProject): { readonly node: ReactNode; readonly tip: string } | null => {
  const want = p.want;
  if (want !== undefined) {
    if (want.word === "blocked") {
      return { node: <Text size="xs" tone="danger">blocked</Text>, tip: want.label };
    }
    // The word in the warning colour and weight carries it: no dot (DESIGN.md).
    return {
      node: (
        <>
          <Text size="xs" tone="warning" strong>
            {want.word ?? "needs you"}
          </Text>
          {want.count > 1 ? <span>{`· ${String(want.count)}`}</span> : null}
        </>
      ),
      tip: want.label,
    };
  }
  if (p.unread) return { node: <Dot color="var(--accent)" label={UNREAD} />, tip: UNREAD };
  // It stops nothing, so the word without the weight that asks for you.
  if (p.warning !== undefined) return { node: <Text size="xs" tone="warning">CI red</Text>, tip: p.warning };
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
        <Tooltip content={tip === undefined ? undefined : <HubText>{tip}</HubText>}>
          <span className={s.mark} aria-label={tip}>
            {m.node}
          </span>
        </Tooltip>
      )}
      {jump !== null ? <span className={s.jump}>{jump}</span> : null}
    </>
  );
};

export function Sidebar({ projects, screen, jumpHints, collapsed, onToggleHub, factory, admin, go }: SidebarProps) {
  const hubs = useHubs();
  const loaded = useHubRows();
  const nav = (label: string, icon: ReactNode, target: Screen, current: boolean, trailing?: ReactNode) => (
    <SidebarItem label={label} icon={icon} current={current} trailing={trailing} onClick={() => go(target)} />
  );

  const several = hubs.length > 1;
  // ⌘1..9 count the rows on show, in order: a collapsed group's rows have none.
  const shown = projects === undefined ? undefined : shownRows(projects, collapsed, several);
  const jumpOf = (p: Placed): number | null => {
    const at = shown?.indexOf(p) ?? -1;
    return jumpHints && at >= 0 && at < 9 ? at + 1 : null;
  };

  return (
    <Frame
      aria-label="Sidebar"
      footer={
        // Each hub, and any update to it, on a row of its own.
        <div className={s.footers}>
          {hubs.map((hub) => (
            <HubScope key={hub.id} hub={hub}>
              <HubFooter />
            </HubScope>
          ))}
        </div>
      }
    >
      {projects === undefined ? null : (
        <NaviSection navis={projects.filter((p) => isNavi(p.project))} all={projects} named={several} screen={screen} jumpOf={jumpOf} go={go} />
      )}
      {hubs.map((hub) => {
        // A hub whose projects haven't loaded (offline from the start, say) waits on its own; the others show theirs.
        const waiting = projects === undefined || (loaded.has(hub.id) && loaded.get(hub.id)?.projects === undefined);
        // Its Navis are in the Navi section above.
        const rows = waiting ? undefined : projects.filter((p) => p.hub === hub.id && !isNavi(p.project));
        return (
          <HubScope key={hub.id} hub={hub}>
            <ProjectGroup
              rows={rows}
              all={projects ?? []}
              named={several}
              collapsed={several && collapsed.has(hub.id)}
              onToggle={() => onToggleHub(hub.id)}
              open={screen.id === "project" && screen.at === hub.id ? screen.project : null}
              jumpOf={jumpOf}
              go={go}
            />
          </HubScope>
        );
      })}

      <SidebarSection>
        {nav("Status", <Activity />, { id: "status" }, screen.id === "status", kbd("status.toggle"))}
        {nav(
          "Factory",
          <Factory />,
          factory ? { id: "factory", project: null } : { id: "time", orderId: null },
          screen.id === "factory" || screen.id === "time",
          // A hub from before metrics has no ⌘; (factory/support.ts).
          factory ? kbd("factory.open") : undefined,
        )}
        <SettingsEntry current={screen.id === "settings"} admin={admin} trailing={kbd("settings.open")} go={go} />
      </SidebarSection>
    </Frame>
  );
}

/**
 * The Navis, every hub's, pinned above the projects; with several hubs each says its hub. With none yet, one quiet row
 * to meet Navi (on the hub of the screen you're on), with no heading over it.
 */
function NaviSection(props: {
  navis: ReadonlyArray<Placed>;
  all: ReadonlyArray<Placed>;
  named: boolean;
  screen: Routed;
  jumpOf: (p: Placed) => number | null;
  go: (screen: Screen) => void;
}) {
  const { navis, all, named, screen, go } = props;
  const hubs = useHubs();
  const rows = useMemo(() => byKey(navis), [navis]);
  // With several hubs, a Navi moves among its own hub's: each hub keeps the order of its own.
  const reorder = useReorder({
    keys: useMemo(() => navis.map((p) => p.key), [navis]),
    name: (key) => rows.get(key)?.project.title ?? "",
    group: named ? (key) => rows.get(key)?.hub ?? "" : undefined,
    onMove: (order, key) => {
      const hub = rows.get(key)?.hub;
      if (hub !== undefined) save(hubs.find((h) => h.id === hub)?.layer, all, hub, order);
    },
  });
  if (navis.length === 0) {
    return (
      <SidebarSection label="Navi">
        <SidebarItem label="Meet Navi" icon={<Sparkle />} current={screen.id === "navi"} onClick={() => go({ id: "navi" })} />
      </SidebarSection>
    );
  }
  return (
    <SidebarSection
      title="Navi"
      action={
        <Button variant="quiet" size="sm" icon={<Plus />} onClick={() => go({ id: "navi" })} aria-label="New Navi">
          New
        </Button>
      }
    >
      <div {...reorder.list}>
        {reorder.shown.map((key) => {
          const p = rows.get(key);
          const hub = p === undefined ? undefined : hubs.find((h) => h.id === p.hub);
          return p === undefined || hub === undefined ? null : (
            <div key={key} {...reorder.row(key)}>
              <HubScope hub={hub}>
                <NaviRow
                  p={p}
                  named={named}
                  current={screen.id === "project" && screen.at === p.hub && sameProject(screen.project, p.project)}
                  jump={props.jumpOf(p)}
                  go={go}
                />
              </HubScope>
            </div>
          );
        })}
      </div>
      <span role="status" className={s.srOnly}>
        {reorder.status}
      </span>
    </SidebarSection>
  );
}

/** One Navi, in its hub's scope: its menu renames or archives it there. */
function NaviRow({ p, named, current, jump, go }: { p: Placed; named: boolean; current: boolean; jump: number | null; go: (screen: Screen) => void }) {
  const hub = useHub();
  const layer = useDataLayer();
  const asOf = useOfflineAsOf();
  const [renaming, setRenaming] = useState<NaviTarget | null>(null);
  const at = named ? { at: hub.id } : {};
  const { machineId, projectId, title, workspaceRoot } = p.project;
  const open = () => go({ id: "project", project: routeOf(p), message: null, ...at });
  const menu = () => (
    <>
      <ContextMenuItem onSelect={open}>Open</ContextMenuItem>
      <ContextMenuItem onSelect={() => setRenaming({ machineId, projectId, title })}>Rename…</ContextMenuItem>
      {/* Its connections (MCP servers) are in its settings. */}
      <ContextMenuItem onSelect={() => go({ id: "settings", tab: "projects", for: `${machineId}/${projectId}`, ...at })}>Open settings</ContextMenuItem>
      <ContextMenuCopy text={workspaceRoot}>Copy folder path</ContextMenuCopy>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void archiveNavi(layer, { machineId, projectId, title })}>Archive</ContextMenuItem>
    </>
  );
  return (
    <>
      <ContextMenu menu={menu}>
        <SidebarItem
          label={p.project.title}
          tall
          icon={<ProjectAvatar project={p.project} size={SIDEBAR_AVATAR} />}
          current={current}
          emphasis={p.unread}
          trailing={
            <>
              {named ? <span className={s.naviHub}>{hub.label}</span> : null}
              {trailing(p, jump, asOf)}
            </>
          }
          onClick={open}
        />
      </ContextMenu>
      <RenameNaviDialog navi={renaming} onClose={() => setRenaming(null)} />
    </>
  );
}

/** A hub's row in the footer, and any update to it at its end. */
function HubFooter() {
  const hub = useHubState();
  return (
    <div className={s.footer}>
      <HubStatus hub={hub} />
      <UpdatesLine />
    </div>
  );
}

/**
 * One hub's projects. Named, it is a group under the hub's name (a click collapses it, and collapsed it still says
 * how many projects want you); unnamed, the one hub's "Projects" as always.
 */
function ProjectGroup(props: {
  rows: ReadonlyArray<Placed> | undefined;
  /** Every hub's rows: this hub's whole order is saved from them. */
  all: ReadonlyArray<Placed>;
  named: boolean;
  collapsed: boolean;
  onToggle: () => void;
  open: ProjectKey | null;
  jumpOf: (p: Placed) => number | null;
  go: (screen: Screen) => void;
}) {
  const { rows, named, collapsed, open, go } = props;
  const hub = useHub();
  const state = useHubState();
  const asOf = useOfflineAsOf();
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);
  const layer = useDataLayer();
  const rowsByKey = useMemo(() => byKey(rows ?? []), [rows]);
  const reorder = useReorder({
    keys: useMemo(() => rows?.map((p) => p.key) ?? [], [rows]),
    name: (key) => rowsByKey.get(key)?.project.title ?? "",
    onMove: (order) => save(layer, props.all, hub.id, order),
  });
  const at = named ? { at: hub.id } : {};
  const openRow = (p: SidebarProject) => go({ id: "project", project: routeOf(p), message: null, ...at });
  const menu = (p: SidebarProject) => () => {
    const { machineId, projectId, title, workspaceRoot } = p.project;
    return (
      <>
        <ContextMenuItem onSelect={() => openRow(p)}>Open</ContextMenuItem>
        <ContextMenuItem onSelect={() => go({ id: "settings", tab: "projects", for: `${machineId}/${projectId}`, ...at })}>Open settings</ContextMenuItem>
        <ContextMenuCopy text={workspaceRoot}>Copy path</ContextMenuCopy>
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={() => setRemoving({ machineId, projectId, title, path: workspaceRoot })}>
          Remove project…
        </ContextMenuItem>
      </>
    );
  };
  const wanting = rows?.filter((p) => p.want !== undefined).length ?? 0;
  const head = named ? (
    <button type="button" className={s.groupHead} aria-expanded={!collapsed} onClick={props.onToggle} data-hub-group={hub.id}>
      {collapsed ? <ChevronRight aria-hidden /> : <ChevronDown aria-hidden />}
      {hub.color === undefined ? null : <span className={s.groupMark} style={{ background: HUB_COLOR[hub.color] }} aria-hidden />}
      <Truncate size="xs" tone="inherit" expand="none">
        {hub.label}
      </Truncate>
      {asOf === undefined ? null : <span className={s.groupAside}>{asOf}</span>}
      {collapsed && wanting > 0 ? (
        <Text size="xs" tone="warning" strong>
          {wanting === 1 ? "needs you" : `${String(wanting)} need you`}
        </Text>
      ) : null}
    </button>
  ) : undefined;

  return (
    <SidebarSection
      {...(named ? { head, label: hub.label } : { title: asOf === undefined ? "Projects" : `Projects, ${asOf}` })}
      action={
        <Button variant="quiet" size="sm" icon={<Plus />} aria-label={named ? `Add a project on ${hub.label}` : undefined} onClick={() => go({ id: "projects.add", ...at })}>
          Add
        </Button>
      }
    >
      {collapsed ? null : rows === undefined ? (
        // Loading (startup, or a resync after the link dropped): never the "no projects" sentence, never old rows.
        // Busy only while something is on its way, not while the hub is unreachable.
        <div className={s.sidebarSkeleton} aria-busy={state.phase === "live" || state.phase === "connecting"} aria-label="Loading projects">
          <span />
          <span />
          <span />
        </div>
      ) : rows.length === 0 ? (
        <Text as="p" size="xs" tone="quiet" className={s.sidebarNote}>
          No projects yet. Add one: a GitHub repo, or a folder on one of your machines.
        </Text>
      ) : (
        <div {...reorder.list}>
          {reorder.shown.map((key) => {
            const p = rowsByKey.get(key);
            return p === undefined ? null : (
              <div key={key} {...reorder.row(key)}>
                <ContextMenu menu={menu(p)}>
                  <SidebarItem
                    label={p.project.title}
                    tall
                    icon={<ProjectAvatar project={p.project} size={SIDEBAR_AVATAR} />}
                    current={sameProject(open, p.project)}
                    emphasis={p.unread}
                    trailing={trailing(p, props.jumpOf(p), asOf)}
                    onClick={() => openRow(p)}
                  />
                </ContextMenu>
              </div>
            );
          })}
        </div>
      )}
      <span role="status" className={s.srOnly}>
        {reorder.status}
      </span>
      <RemoveProjectDialog project={removing} onClose={() => setRemoving(null)} />
    </SidebarSection>
  );
}
