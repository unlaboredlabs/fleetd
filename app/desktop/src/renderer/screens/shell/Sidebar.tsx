// The sidebar (W530): your chats, each a row with its picture, its name and its newest line, newest first, and you at
// its foot (You.tsx). New sits at the top, beside the window's controls (NewButton). Your pinned chats stay on top in
// your order (pins.ts): drag one, or move a focused one with ⌥↑ / ⌥↓, among them; every other chat takes its place by
// its newest line (latest.ts) and glides there on the app's spring when it moves, the one kinetic moment here. While
// the pointer is over the list nothing moves (sidebarState.ts holdRows): what changed takes its place once it leaves,
// so a row never moves under a click. A row ends in a dot while its chat wants you (a reply, an approval, a secret, a
// block: the warning's colour, why in its tooltip) or has a new message (the accent's, its line in full voice), else
// says a red main or the agents at work; and when its line was written. Holding ⌘ (Ctrl) shows jump numbers in place of the times on the first nine
// rows, which ⌘1..9 open. A row's right-click menu opens it or its settings, pins or unpins it, renames it, copies its
// path, archives it (Undo in the toast) or deletes it (from its settings, which list its worktrees and ask for its
// name first). An archived project is in none (Settings › Projects brings it back).
//
// With several hubs each hub's chats are a group under its name, which collapses. With one, there is no name and no
// group.
import { ChevronDown, ChevronRight, Pin, Plus } from "lucide-react";
import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import type { DataLayer } from "../../src/data/queries";
import { HubScope, useDataLayer, useHub, useHubs } from "../../src/data/react";
import { archiveProject, RenameProjectDialog, type ProjectTarget } from "../projects/actions";
import { Button, ContextMenu, ContextMenuCopy, ContextMenuItem, ContextMenuSeparator, StateGlyph, toast, Tooltip, Truncate, useReorder } from "../../ui";
import { ProjectAvatar } from "../projects/ProjectAvatar";
import { revealNext } from "../settings/reveal";
import { useHubState } from "./hubFeed";
import { useHubRows } from "./hubRows";
import { HUB_COLOR } from "./hubColor";
import { HubText } from "../projects/HubText";
import { routeOf, type SidebarProject } from "./model";
import type { Routed } from "./navigation";
import { useOfflineAsOf } from "./offline";
import { PINS_MAX, savePins } from "./pins";
import { sameProject, type ProjectKey, type Screen } from "./routes";
import type { Placed } from "./Shell";
import { holdRows, shownRows } from "./sidebarState";
import { You } from "./You";
import s from "./sidebar.module.css";

/** A chat's picture in its row: big enough to enjoy its face, the row 56 px around it. */
const AVATAR = 36;
/** The glide to a new place: the app's spring (--ease-spring, --dur-spring in tokens.css). */
export const SPRING = { ms: 360, ease: "var(--ease-spring)" } as const;

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
  readonly go: (screen: Screen) => void;
}

const UNREAD = "New message from the lead";

/** New, at the sidebar's top beside the window's controls: a project on the screen's hub. */
export function NewButton({ go }: { go: (screen: Screen) => void }) {
  return (
    <Tooltip content="New project">
      <button type="button" className={s.new} aria-label="New project" data-opens="projects.add" onClick={() => go({ id: "projects.add" })}>
        <Plus aria-hidden />
      </button>
    </Tooltip>
  );
}

/** When a line was written, as a chats list says it: "09:14" today, "Yesterday", "Tue" this week, else "3 Nov". */
export const whenShort = (iso: string, now = new Date()): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return at.toLocaleDateString(undefined, { weekday: "short" });
  return at.toLocaleDateString(undefined, at.getFullYear() === now.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "2-digit" });
};

/** The row's one mark: a dot while it wants you or has a new message, else a red main, else how many agents work. */
const mark = (p: SidebarProject): { readonly node: ReactNode; readonly tip: string } | null => {
  const want = p.want;
  // A dot, the whole message (the human's call, W530): the warning's for one that waits on you, the accent's for a new
  // message; its words in the tooltip and the row's description.
  if (want !== undefined) return { node: <span className={s.dot} data-want={want.word ?? "you"} aria-hidden />, tip: want.label };
  if (p.unread) return { node: <span className={s.dot} aria-hidden />, tip: UNREAD };
  // It stops nothing, so the word without the weight that asks for you.
  if (p.warning !== undefined) return { node: <span className={s.red}>CI red</span>, tip: p.warning };
  if (p.running > 0) {
    return {
      node: (
        <span className={s.work}>
          <StateGlyph state="working" size="sm" />
          {String(p.running)}
        </span>
      ),
      tip: `${String(p.running)} ${p.running === 1 ? "agent" : "agents"} working`,
    };
  }
  if (p.working) return { node: <StateGlyph state="thinking" size="sm" />, tip: "The lead is working" };
  if (p.pinned) return { node: <Pin className={s.pin} aria-hidden />, tip: "Pinned" };
  return null;
};

/** The row's line: its newest, else while its lead works that it does, else why it wants you, else that it is new. */
const lineOf = (p: SidebarProject): string => p.line || (p.working ? "Working…" : (p.want?.label ?? "No messages yet"));

interface RowProps extends Omit<ComponentProps<"button">, "children"> {
  readonly p: SidebarProject;
  readonly current: boolean;
  readonly jump: number | null;
  readonly asOf: string | undefined;
}

/** One chat's row: picture, name and time, then its line and its mark. The menu's trigger props go on its button. */
function Row({ p, current, jump, asOf, ...rest }: RowProps) {
  const m = mark(p);
  // Offline the marks are the last known ones, and their words say since when ("as of 09:02").
  const tip = m === null || asOf === undefined ? m?.tip : `${m.tip}, ${asOf}`;
  return (
    <button
      type="button"
      className={s.row}
      {...(current ? { "aria-current": "page" as const } : {})}
      data-unread={p.unread || undefined}
      data-pinned={p.pinned || undefined}
      aria-description={tip}
      {...rest}
    >
      <ProjectAvatar project={p.project} size={AVATAR} className={s.avatar} />
      <span className={s.text}>
        <span className={s.top}>
          <span className={s.name}>{p.project.title}</span>
          {jump !== null ? <span className={s.jump}>{jump}</span> : <span className={s.when}>{whenShort(p.at)}</span>}
        </span>
        <span className={s.bottom}>
          <span className={s.line} data-empty={p.line === "" || undefined}>
            <HubText>{lineOf(p)}</HubText>
          </span>
          {m === null ? null : (
            <Tooltip content={tip === undefined ? undefined : <HubText>{tip}</HubText>}>
              <span className={s.mark}>{m.node}</span>
            </Tooltip>
          )}
        </span>
      </span>
    </button>
  );
}

export function Sidebar({ projects, screen, jumpHints, collapsed, onToggleHub, factory, go }: SidebarProps) {
  const hubs = useHubs();
  const loaded = useHubRows();
  const several = hubs.length > 1;
  // ⌘1..9 count the rows on show, in order: a collapsed group's rows have none.
  const shown = projects === undefined ? undefined : shownRows(projects, collapsed, several);
  const jumpOf = (p: Placed): number | null => {
    const at = shown?.indexOf(p) ?? -1;
    return jumpHints && at >= 0 && at < 9 ? at + 1 : null;
  };
  // Nothing outlives the sidebar holding its rows.
  useEffect(() => () => holdRows(null), []);
  const keys = projects?.map((p) => p.key);

  return (
    <nav className={s.sidebar} aria-label="Sidebar">
      <div className={s.list} onPointerEnter={() => holdRows(keys ?? null)} onPointerLeave={() => holdRows(null)}>
        {hubs.map((hub) => {
          // A hub whose projects haven't loaded (offline from the start, say) waits on its own; the others show theirs.
          const waiting = projects === undefined || (loaded.has(hub.id) && loaded.get(hub.id)?.projects === undefined);
          const rows = waiting ? undefined : projects.filter((p) => p.hub === hub.id);
          return (
            <HubScope key={hub.id} hub={hub}>
              <ProjectGroup
                rows={rows}
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
      </div>
      <You screen={screen} factory={factory} go={go} />
    </nav>
  );
}

/** Saves `layer`'s pins as `keys` (row keys) name them, from `rows`. */
const pin = (layer: DataLayer, rows: ReadonlyArray<Placed>, keys: readonly string[]) => {
  const byKey = new Map(rows.map((p) => [p.key, p]));
  void savePins(
    layer,
    keys.flatMap((k) => {
      const p = byKey.get(k);
      return p === undefined ? [] : [routeOf(p)];
    }),
  );
};

/** Placeholder rows while the chats load: their shapes, still, so nothing repaints. */
const Loading = ({ busy }: { busy: boolean }) => (
  <div className={s.loading} aria-busy={busy} aria-label="Loading projects">
    {[72, 56, 64].map((w) => (
      <span key={w} className={s.ghost}>
        <span className={s.ghostAvatar} />
        <span className={s.ghostText}>
          <span style={{ width: `${String(w - 24)}%` }} />
          <span style={{ width: `${String(w)}%` }} />
        </span>
      </span>
    ))}
  </div>
);

/**
 * One hub's chats. Named, they are a group under the hub's name (a click collapses it, and collapsed it still says how
 * many want you); unnamed, just the rows.
 */
function ProjectGroup(props: {
  rows: ReadonlyArray<Placed> | undefined;
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
  const rowsByKey = useMemo(() => new Map((rows ?? []).map((p) => [p.key, p])), [rows]);
  const pinned = useMemo(() => (rows ?? []).filter((p) => p.pinned).map((p) => p.key), [rows]);
  const reorder = useReorder({
    keys: useMemo(() => rows?.map((p) => p.key) ?? [], [rows]),
    name: (key) => rowsByKey.get(key)?.project.title ?? "",
    // Only pinned rows lift: the others' order is their activity's. A pinned row dropped among them stays last of the pinned.
    onMove: (order) => pin(layer, rows ?? [], order.filter((k) => pinned.includes(k))),
    settle: SPRING,
  });
  const at = named ? { at: hub.id } : {};
  const openRow = (p: SidebarProject) => go({ id: "project", project: routeOf(p), message: null, ...at });
  const menu = (p: Placed) => () => {
    const { machineId, projectId, title, workspaceRoot } = p.project;
    return (
      <>
        <ContextMenuItem onSelect={() => openRow(p)}>Open</ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            if (p.pinned) return pin(layer, rows ?? [], pinned.filter((k) => k !== p.key));
            if (pinned.length >= PINS_MAX) {
              toast({ title: `Up to ${String(PINS_MAX)} chats can be pinned`, description: "Unpin one to pin this one." });
              return;
            }
            pin(layer, rows ?? [], [...pinned, p.key]);
          }}
        >
          {p.pinned ? "Unpin" : "Pin to top"}
        </ContextMenuItem>
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

  return (
    <section className={s.group} aria-label={named ? hub.label : "Projects"}>
      {named ? (
        <button type="button" className={s.groupHead} aria-expanded={!collapsed} onClick={props.onToggle} data-hub-group={hub.id}>
          {collapsed ? <ChevronRight aria-hidden /> : <ChevronDown aria-hidden />}
          {hub.color === undefined ? null : <span className={s.groupMark} style={{ background: HUB_COLOR[hub.color] }} aria-hidden />}
          <Truncate size="xs" tone="inherit" expand="none">
            {hub.label}
          </Truncate>
          {asOf === undefined ? null : <span className={s.groupAside}>{asOf}</span>}
          {collapsed && wanting > 0 ? <span className={s.want}>{wanting === 1 ? "needs you" : `${String(wanting)} need you`}</span> : null}
        </button>
      ) : null}
      {collapsed ? null : rows === undefined ? (
        // Loading (startup, or a resync after the link dropped): never the "no projects" words, never old rows. Busy
        // only while something is on its way, not while the hub is unreachable.
        <Loading busy={state.phase === "live" || state.phase === "connecting"} />
      ) : rows.length === 0 ? (
        <div className={s.empty}>
          <span className={s.emptyTitle}>No chats yet</span>
          <span className={s.emptyText}>A project is a chat with its own lead: on a GitHub repo, a folder on one of your machines, or nothing at all.</span>
          <Button size="sm" onClick={() => go({ id: "projects.add", ...at })}>
            New project
          </Button>
        </div>
      ) : (
        <div className={s.rows} {...reorder.list}>
          {reorder.shown.map((key, i) => {
            const p = rowsByKey.get(key);
            if (p === undefined) return null;
            const handle = reorder.row(key);
            // Every row glides; only a pinned one lifts or moves with ⌥↑ / ⌥↓.
            const wrap = p.pinned ? handle : { ref: handle.ref, style: handle.style, "data-reorder-row": handle["data-reorder-row"] };
            const last = p.pinned && rowsByKey.get(reorder.shown[i + 1] ?? "")?.pinned !== true && i < reorder.shown.length - 1;
            return (
              <div key={key} {...wrap} data-pins-end={last || undefined}>
                <ContextMenu menu={menu(p)}>
                  <Row p={p} current={sameProject(open, p.project)} jump={props.jumpOf(p)} asOf={asOf} onClick={() => openRow(p)} />
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
    </section>
  );
}
