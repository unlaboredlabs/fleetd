// The sidebar: each hub's projects in your own order: drag a row, or move a focused one with ⌥↑ / ⌥↓, and it stays
// there on each of your desktops (yourOrder.ts; new ones go at the end, your own Only-me ones first, and nothing moves
// by itself, so a row never moves under the pointer). Each opens its chat and says why it wants you ("reply",
// "approve", "secret", "blocked") or how many agents work; a chat with a message you haven't seen is bold. An archived
// project is in none (Settings › Projects brings it back). Then three rows: Status, Factory (its Agent time tab too) and
// Settings, which for an admin says how many of the hub's required setup steps are left and opens on them (a project's
// agents and PRs are in the panel beside its chat); then any update to make, and the hub (HubStatus), which says how
// many machines are down and opens Machines. Holding ⌘ (Ctrl) shows jump numbers on the first nine rows, which ⌘1..9
// open. A project's right-click menu opens it or its settings, renames it, copies its path, archives it (Undo in the
// toast) or deletes it (from its settings, which list its worktrees and ask for its name first).
//
// With several hubs each hub's projects are a group under its name, which collapses; the footer has a row per hub.
// With one, there is no name and no group, as before.
import { ChevronDown, ChevronRight, Factory, MonitorSmartphone, Plus, Settings } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { display, type ShortcutId } from "../../../shared/shortcuts";
import type { DataLayer } from "../../src/data/queries";
import { HubScope, useData, useDataLayer, useHub, useHubs, useToolQuery } from "../../src/data/react";
import { archiveProject, RenameProjectDialog, type ProjectTarget } from "../projects/actions";
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
import { revealNext } from "../settings/reveal";
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
/** A project's icon in its tall row (SidebarItem `tall`): big enough to enjoy its glass face, the row 48 px around it. */
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

const NO_INPUT = {} as const;

/**
 * Screens (D305): the words when one asks for you, else how many are live. One hub-wide count (screens_count, read
 * again on each screen's event), never a project's list: the row is always there.
 */
function ScreensEntry({ current, go }: { current: boolean; go: (screen: Screen) => void }) {
  // The hub feature that brings screens_count (screensPage/data's THUMBS; named here so the shell loads none of the page).
  const served = useData((d) => d.features.includes("screen_thumbs"));
  const count = useToolQuery("screens_count", NO_INPUT, { enabled: served }).data;
  const asking = count?.asking ?? 0;
  const live = count?.live ?? 0;
  const trailing =
    asking > 0 ? (
      <Text size="xs" tone="warning" strong>
        needs you
      </Text>
    ) : live > 0 ? (
      <Text size="xs" tone="faint" tabular>
        {String(live)}
      </Text>
    ) : undefined;
  return <SidebarItem label="Screens" icon={<MonitorSmartphone />} current={current} trailing={trailing} onClick={() => go({ id: "screens", open: null })} />;
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
      {hubs.map((hub) => {
        // A hub whose projects haven't loaded (offline from the start, say) waits on its own; the others show theirs.
        const waiting = projects === undefined || (loaded.has(hub.id) && loaded.get(hub.id)?.projects === undefined);
        const rows = waiting ? undefined : projects.filter((p) => p.hub === hub.id);
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
        <ScreensEntry current={screen.id === "screens"} go={go} />
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
  const [renaming, setRenaming] = useState<ProjectTarget | null>(null);
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
        <ContextMenuItem onSelect={() => setRenaming({ machineId, projectId, title })}>Rename…</ContextMenuItem>
        {/* Its connections, sign-ins, approvals and the rest are in its settings. */}
        <ContextMenuItem onSelect={() => go({ id: "settings", tab: "projects", for: `${machineId}/${projectId}`, ...at })}>Open settings</ContextMenuItem>
        <ContextMenuCopy text={workspaceRoot}>Copy path</ContextMenuCopy>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void archiveProject(layer, { machineId, projectId, title })}>Archive</ContextMenuItem>
        {/* Delete erases everything fleetd keeps for it: its settings' Delete lists its worktrees and asks for its name. */}
        <ContextMenuItem
          danger
          onSelect={() => {
            revealNext("projects.delete");
            go({ id: "settings", tab: "projects", for: `${machineId}/${projectId}`, ...at });
          }}
        >
          Delete project…
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
        <Button variant="quiet" size="sm" icon={<Plus />} aria-label={named ? `New project on ${hub.label}` : "New project"} onClick={() => go({ id: "projects.add", ...at })}>
          New
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
          No projects yet. Start one: a chat with its own lead, with a GitHub repo, a folder on one of your machines, or nothing at all.
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
      <RenameProjectDialog project={renaming} onClose={() => setRenaming(null)} />
    </SidebarSection>
  );
}
