// The sidebar (W530): your chats, each a row with its picture, its name and its newest line, newest first, and you at
// its foot (You.tsx). New sits at the top, beside the window's controls (NewButton). Your pinned chats stay on top in
// your order (pins.ts), two to a line, each a large picture over its name in a capsule (a name cut short shows whole
// in a tooltip): drag one, or move a focused one with ⌥↑ / ⌥↓, among them; drag a chat up among them to pin it
// there, or a pin down out of them to unpin it. Every other chat takes its place by
// its newest line (latest.ts) and glides there on the app's spring when it moves, the one kinetic moment here. While
// the pointer is over the list nothing moves (sidebarState.ts holdRows): what changed takes its place once it leaves,
// so a row never moves under a click. A row ends in a dot while its chat wants you (a reply, an approval, a secret, a
// block: the warning's colour, why in its tooltip) or has a new message (the accent's, its line in full voice), else
// says a red main or the agents at work; and when its line was written. Holding ⌘ (Ctrl) shows jump numbers in place of the times on the first nine
// rows, which ⌘1..9 open. A row's right-click menu opens it or its settings, pins or unpins it, renames it, copies its
// path, archives it (Undo in the toast) or deletes it (from its settings, which list its worktrees and ask for its
// name first). An archived project is in none (Settings › Projects brings it back).
//
// Your own sections (sections.ts) come under the chats in none, each under a quiet label, in your order, its chats
// newest first: a row's menu moves it to one, out of them, or into a new one you name; dragging it onto a section's
// label or one of its chats moves it there too, and onto a chat in none takes it out, the held row saying where it
// would go where its time was. A label's click folds its section to one line, kept on this computer
// (sidebarState.ts); its menu renames the section, moves it up or down, or removes it (its chats go back on top). A
// pinned chat shows among the pins only, and keeps its section.
//
// With several hubs each hub's chats are a group under its name, which collapses. With one, there is no name and no
// group.
import { ArrowRight, ChevronDown, ChevronRight, Pin, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { ChatSection } from "../../../shared/contracts";
import type { DataLayer } from "../../src/data/queries";
import { HubScope, useDataLayer, useHub, useHubs } from "../../src/data/react";
import { archiveProject, RenameProjectDialog, type ProjectTarget } from "../projects/actions";
import { Button, ContextMenu, ContextMenuCopy, ContextMenuItem, ContextMenuSeparator, isCut, observeSize, StateGlyph, toast, Tooltip, Truncate, useReorder } from "../../ui";
import { ProjectAvatar } from "../projects/ProjectAvatar";
import type { BotIn } from "../../../shared/bot";
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
import { MoveToSection, SectionLabel, SectionNameDialog, type Naming } from "./SectionLabel";
import { addSection, moveChat, moveSection, newSectionId, removeSection, renameSection, saveSections, sectionLines, useSections } from "./sections";
import type { Placed } from "./Shell";
import { foldKey, holdRows, shownRows } from "./sidebarState";
import { You } from "./You";
import s from "./sidebar.module.css";

/** A chat's picture in its row: big enough to enjoy its face, the row a 56 px capsule around it. */
const AVATAR = 40;
/** A pinned chat's picture, PIN_COLUMNS to a row 16 px apart, the group centred in the sidebar. */
const PIN_AVATAR = 72;
const PIN_COLUMNS = 2;
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
  /** Your sections folded, by foldKey (the frame keeps them too: a folded section's chats have no ⌘ number). */
  readonly folded: ReadonlySet<string>;
  readonly onToggleSection: (key: string) => void;
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
  return null;
};

/** What the row knows of its bot beyond the project's row: why it wants you, and a reply you haven't seen. */
const botOwn = (p: SidebarProject): Partial<BotIn> => ({ needs: p.want !== undefined && p.want.word !== "blocked", blocked: p.want?.word === "blocked", done: p.unread });

/** The row's line: its newest, else while its lead works that it does, else why it wants you, else that it is new. */
const lineOf = (p: SidebarProject): string => p.line || (p.working ? "Working…" : (p.want?.label ?? "No messages yet"));

interface RowProps extends Omit<ComponentProps<"button">, "children"> {
  readonly p: SidebarProject;
  readonly current: boolean;
  readonly jump: number | null;
  readonly asOf: string | undefined;
  /** Held over one of your sections or a chat in none, where it would go if let go, shown where the time is. */
  readonly into?: string | undefined;
}

/** One chat's row: picture, name and time, then its line and its mark. The menu's trigger props go on its button. */
function Row({ p, current, jump, asOf, into, ...rest }: RowProps) {
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
      <ProjectAvatar project={p.project} size={AVATAR} own={botOwn(p)} className={s.avatar} />
      <span className={s.text}>
        <span className={s.top}>
          <span className={s.name}>{p.project.title}</span>
          {into !== undefined ? (
            <span className={s.into}>
              <ArrowRight aria-hidden />
              <span>{into}</span>
            </span>
          ) : jump !== null ? (
            <span className={s.jump}>{jump}</span>
          ) : (
            <span className={s.when}>{whenShort(p.at)}</span>
          )}
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

/**
 * A pinned chat, after the phone's pins (mobile screens/Pinned.tsx, after Messages): a large round picture standing
 * free, its name under it in a small capsule, two to a row over the list. New, the name speaks up with the dot before
 * it in the capsule (the warning's when it waits on you); while its lead works, the picture's own bot says so, with no
 * bubble of its own, and a picture of the project's own, which can't, has the row's small working glyph in the dot's
 * place. While ⌘ (Ctrl) is held, its jump number stands before the name in the dot's place, as a row's stands in its
 * time's: the pins are ⌘1 onwards. Open or under the pointer, the capsule takes the shade, as the top bar's pill does.
 * A name too long for its place ends in an ellipsis, and is whole in a tooltip under the pin: only a cut name has a
 * tooltip at all, as ui's Truncate does it, so a pin whose name fits never starts one.
 */
function PinCell({ p, current, jump, asOf, ...rest }: RowProps) {
  const m = mark(p);
  const tip = m === null || asOf === undefined ? m?.tip : `${m.tip}, ${asOf}`;
  const dot = p.want !== undefined ? "want" : p.unread ? "new" : undefined;
  // The name's element lives in state (a callback ref): the pin is a new node once its tooltip comes or goes.
  const [title, setTitle] = useState<HTMLSpanElement | null>(null);
  const [cut, setCut] = useState(false);
  const refocus = useRef(false);
  useLayoutEffect(() => {
    // Right after a swap this can still hold the node React just removed; the next run has the new one.
    if (!title?.isConnected) return;
    const pin = title.closest("button");
    if (refocus.current) {
      refocus.current = false;
      pin?.focus();
    }
    const measure = () => {
      const now = isCut(title);
      // The swap takes the pin's node: a pin that had the keyboard keeps it.
      if (now !== cut && pin === document.activeElement) refocus.current = true;
      setCut(now);
    };
    measure();
    return observeSize(title, measure);
  }, [title, cut, p.project.title]);
  return (
    <Tooltip content={cut ? p.project.title : undefined} side="bottom">
      <button
        type="button"
        className={s.pinCell}
        {...(current ? { "aria-current": "page" as const } : {})}
        data-unread={dot !== undefined || undefined}
        aria-description={tip}
        {...rest}
      >
        <ProjectAvatar project={p.project} size={PIN_AVATAR} own={botOwn(p)} />
        <span className={s.pinName}>
          {jump !== null ? (
            <span className={s.jump}>{jump}</span>
          ) : dot !== undefined ? (
            <span className={s.dot} data-want={dot === "want" ? "you" : undefined} aria-hidden />
          ) : p.project.avatar !== undefined && (p.working || p.running > 0) ? (
            <StateGlyph state="thinking" size="sm" />
          ) : null}
          <span ref={setTitle} className={s.pinTitle}>
            {p.project.title}
          </span>
        </span>
      </button>
    </Tooltip>
  );
}

export function Sidebar({ projects, screen, jumpHints, collapsed, onToggleHub, folded, onToggleSection, factory, go }: SidebarProps) {
  const hubs = useHubs();
  const loaded = useHubRows();
  const several = hubs.length > 1;
  // ⌘1..9 count the rows on show, in order: a collapsed group's rows have none, nor a folded section's.
  const shown = projects === undefined ? undefined : shownRows(projects, collapsed, several, folded);
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
                folded={folded}
                onToggleSection={onToggleSection}
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

/**
 * Where a chat let go at `at` (on screen) joins the pins drawn in `cells`: after each one before it in reading order,
 * a row above or level with it and further left. Above them all it goes first; below them, last.
 */
export const pinPlace = (cells: readonly DOMRect[], at: { readonly x: number; readonly y: number }): number =>
  cells.filter((c) => c.bottom <= at.y || (c.top <= at.y && c.left + c.width / 2 < at.x)).length;

/** A section's label among the rows' keys: no chat's key starts so. */
const labelKey = (section: string): string => `\0${section}`;
const NO_SECTIONS: readonly ChatSection[] = [];
/** Where a chat let go on a chat in no section goes: out of its own. No section has this id. */
const NO_SECTION = "";

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
  folded: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
  open: ProjectKey | null;
  jumpOf: (p: Placed) => number | null;
  go: (screen: Screen) => void;
}) {
  const { rows, named, collapsed, open, go } = props;
  const hub = useHub();
  const state = useHubState();
  const asOf = useOfflineAsOf();
  const [renaming, setRenaming] = useState<ProjectTarget | null>(null);
  const [naming, setNaming] = useState<Naming | null>(null);
  const layer = useDataLayer();
  const sections = useSections() ?? NO_SECTIONS;
  const setSections = (next: readonly ChatSection[]) => {
    if (next !== sections) void saveSections(layer, next);
  };
  // Under the pins: the chats in none of your sections, then each section's label and, unless folded, its chats.
  const { folded } = props;
  const lines = useMemo(
    () =>
      sectionLines(
        (rows ?? []).filter((p) => !p.pinned),
        sections,
        (id) => folded.has(foldKey(hub.id, id)),
      ),
    [rows, sections, folded, hub.id],
  );
  const labelled = lines.flatMap((l) => (l.t === "section" ? [l.section.id] : []));
  const rowsByKey = useMemo(() => new Map((rows ?? []).map((p) => [p.key, p])), [rows]);
  const pinned = useMemo(() => (rows ?? []).filter((p) => p.pinned).map((p) => p.key), [rows]);
  const name = (key: string) => rowsByKey.get(key)?.project.title ?? "";
  // The pins lift and move inside their grid, and the hub keeps your order; the other rows' order is their activity's,
  // and they only glide to it.
  // A pin dragged down past them is unpinned; a chat dragged up past the others is pinned where it is let go. Either
  // stays out of the other hubs' groups: let go over one, it goes back. Above the first group and below the last (the
  // sidebar's empty space under a short list, say) are still its own.
  const grid = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLElement>(null);
  const within = () => {
    const el = group.current;
    const box = el?.getBoundingClientRect();
    const hub = (sibling: Element | null | undefined) => sibling?.tagName === "SECTION";
    return [hub(el?.previousElementSibling) ? (box?.top ?? -Infinity) : -Infinity, hub(el?.nextElementSibling) ? (box?.bottom ?? Infinity) : Infinity] as const;
  };
  const pins = useReorder({
    keys: pinned,
    name,
    onMove: (order) => pin(layer, rows ?? [], order),
    settle: SPRING,
    grid: { columns: PIN_COLUMNS },
    within,
    out: (key, way) => {
      if (way === "down") pin(layer, rows ?? [], pinned.filter((k) => k !== key));
    },
  });
  const pinOn = (key: string, at: number) => {
    if (pinned.length >= PINS_MAX) {
      toast({ title: `Up to ${String(PINS_MAX)} chats can be pinned`, description: "Unpin one to pin this one." });
      return;
    }
    pin(layer, rows ?? [], [...pinned.slice(0, at), key, ...pinned.slice(at)]);
  };
  // The labels are among the rows' keys, so they glide and close up with them; only a chat lifts.
  const list = useRef<HTMLDivElement>(null);
  const reorder = useReorder({
    keys: useMemo(() => lines.map((l) => (l.t === "chat" ? l.row.key : labelKey(l.section.id))), [lines]),
    name,
    onMove: () => undefined,
    settle: SPRING,
    fixed: true,
    within,
    out: (key, way, at) => {
      if (way === "up") pinOn(key, pinPlace([...(grid.current?.children ?? [])].map((c) => c.getBoundingClientRect()), at));
    },
    // Over another section's label or one of its chats, a chat let go joins that section; over a chat in none, it
    // leaves its own.
    onto: {
      over: (key, at) => {
        for (const el of list.current?.children ?? []) {
          const box = el.getBoundingClientRect();
          if (!(el instanceof HTMLElement) || el.dataset["lifted"] !== undefined || at.y < box.top || at.y > box.bottom || at.x < box.left || at.x > box.right) continue;
          const to = el.dataset["section"] ?? NO_SECTION;
          return to === (rowsByKey.get(key)?.section ?? NO_SECTION) ? null : to;
        }
        return null;
      },
      drop: (key, to) => {
        const p = rowsByKey.get(key);
        if (p !== undefined) setSections(moveChat(sections, routeOf(p), to === NO_SECTION ? null : to));
      },
    },
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
            pinOn(p.key, pinned.length);
          }}
        >
          {p.pinned ? "Unpin" : "Pin to top"}
        </ContextMenuItem>
        <MoveToSection sections={sections} chat={routeOf(p)} title={title} onMove={(to) => setSections(moveChat(sections, routeOf(p), to))} onNew={setNaming} />
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
  const labelMenu = (section: ChatSection) => () => {
    const at = labelled.indexOf(section.id);
    return (
      <>
        <ContextMenuItem onSelect={() => setNaming({ t: "rename", section })}>Rename…</ContextMenuItem>
        {/* A move only where there is a section on show to move past. */}
        {at > 0 ? <ContextMenuItem onSelect={() => setSections(moveSection(sections, section.id, -1, labelled))}>Move up</ContextMenuItem> : null}
        {at < labelled.length - 1 ? <ContextMenuItem onSelect={() => setSections(moveSection(sections, section.id, 1, labelled))}>Move down</ContextMenuItem> : null}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => setSections(removeSection(sections, section.id))}>Remove section</ContextMenuItem>
      </>
    );
  };
  const wanting = rows?.filter((p) => p.want !== undefined).length ?? 0;

  return (
    <section ref={group} className={s.group} aria-label={named ? hub.label : "Projects"}>
      {named ? (
        <button type="button" className={s.groupHead} aria-expanded={!collapsed} onClick={props.onToggle} data-hub-group={hub.id}>
          {collapsed ? <ChevronRight aria-hidden /> : <ChevronDown aria-hidden />}
          {hub.color === undefined ? null : <span className={s.groupMark} style={{ background: HUB_COLOR[hub.color] }} aria-hidden />}
          <Truncate size="sm" strong tone="inherit" expand="none">
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
        <>
          {/* With nothing pinned yet, a chat being dragged has somewhere to go: a slim place for the first pin. */}
          {pins.shown.length === 0 && reorder.lifted ? (
            <div className={s.pinZone} data-pinning={reorder.leaving === "up" || undefined}>
              <Pin aria-hidden />
              Drop here to pin
            </div>
          ) : null}
          {pins.shown.length === 0 ? null : (
            <div
              ref={grid}
              className={s.pins}
              {...pins.list}
              data-pinning={reorder.leaving === "up" || undefined}
              data-unpinning={pins.leaving === "down" || undefined}
            >
              {pins.shown.map((key) => {
                const p = rowsByKey.get(key);
                if (p === undefined) return null;
                return (
                  <div key={key} className={s.pinSlot} {...pins.row(key)}>
                    <ContextMenu menu={menu(p)}>
                      <PinCell p={p} current={sameProject(open, p.project)} jump={props.jumpOf(p)} asOf={asOf} onClick={() => openRow(p)} />
                    </ContextMenu>
                  </div>
                );
              })}
            </div>
          )}
          <div ref={list} className={s.rows} {...reorder.list}>
            {lines.map((line) => {
              if (line.t === "section") {
                // A label glides and closes up as the rows do, and never lifts.
                const { ref, style } = reorder.row(labelKey(line.section.id));
                return (
                  <div key={labelKey(line.section.id)} ref={ref} style={style} className={s.sectionSlot} data-reorder-row="" data-section={line.section.id}>
                    <ContextMenu menu={labelMenu(line.section)}>
                      <SectionLabel line={line} taking={reorder.onto === line.section.id} onClick={() => props.onToggleSection(foldKey(hub.id, line.section.id))} />
                    </ContextMenu>
                  </div>
                );
              }
              const p = line.row;
              // These glide as their order changes, and lift only to be pinned or to join or leave a section, which
              // the lifted row then says: the row itself may cover the label.
              const row = reorder.row(p.key);
              const to = "data-lifted" in row ? reorder.onto : null;
              const into = to === null ? undefined : to === NO_SECTION ? "No section" : sections.find((x) => x.id === to)?.name;
              return (
                <div key={p.key} {...row} data-section={p.section}>
                  <ContextMenu menu={menu(p)}>
                    <Row p={p} current={sameProject(open, p.project)} jump={props.jumpOf(p)} asOf={asOf} into={into} onClick={() => openRow(p)} />
                  </ContextMenu>
                </div>
              );
            })}
          </div>
        </>
      )}
      <span role="status" className={s.srOnly}>
        {pins.status}
      </span>
      <RenameProjectDialog project={renaming} onClose={() => setRenaming(null)} />
      <SectionNameDialog
        naming={naming}
        sections={sections}
        onName={(n, name) => setSections(n.t === "new" ? addSection(sections, newSectionId(), name, n.chat) : renameSection(sections, n.section.id, name))}
        onClose={() => setNaming(null)}
      />
    </section>
  );
}
