// The sidebar (W530, W714): one hub at a time, its row of its own under the window's traffic lights (on the web its
// first line): the hub's mark and name, which pick another hub and say what is off with one, and the list's ⋯; under it
// search (the palette) and New bot, a plus at the search's end. Then your chats, each a row with its picture, its name
// and its newest line, newest first, and you at the foot with Screens and the Factory as two small icons beside you
// (You.tsx), and with several hubs a small mark for each between them, the one on show filled: a click switches to it,
// and so does a two-finger swipe left or right across the sidebar, the list following the fingers and the next or
// previous hub's sliding in beside it, as Dia's spaces do (hubSwipe.ts). Your pinned chats stay on top in your order
// (pins.ts), up to three to a line, each a picture over its name in a capsule (a name cut short shows whole in a tooltip): drag one, or move a focused one with ⌥↑ / ⌥↓, among them;
// drag a chat up among them to pin it there, or a pin down out of them to unpin it. Every other chat takes its place by
// its newest line (latest.ts) and glides there on the app's spring when it moves, the one kinetic moment here. While
// the pointer is over the list nothing moves (sidebarState.ts holdRows): what changed takes its place once it leaves,
// so a row never moves under a click. A row's second line says what its chat wants of you, in the warning's colour
// ("Approve: Run the stock migration", a secret, a reply, a block), else "Working…" while its lead works, else the line
// its lead last wrote on where things stand, else its newest message (shared/rowLine.ts, W950); the chats that want you
// come first. Its bot says the same at any size: it hops while it needs you, scans while it works, and jumps once when
// a turn lands (shared/bot.ts). A row ends in a dot for a new message (the accent's, its line in full voice), else says
// a red main; and when its line was written. Holding ⌘ (Ctrl) shows jump numbers in place of
// the times on the first nine rows, which ⌘1..9 open. A row's right-click menu opens it or its settings, pins or unpins
// it, renames it, copies its path, archives it (Undo in the toast) or deletes it (from its settings, which list its
// worktrees and ask for its name first). An archived project is in none (the ⋯'s Archived bots, Settings › Projects,
// brings it back). The ⋯ orders the list (the ones that want you first, then newest first; or by name) and makes its rows
// compact (sidebarLayout.ts), kept on this computer.
//
// The chats in none of your sections come first (under a quiet Bots label once you have sections), then your sections
// (sections.ts), each under its quiet label, in your order: a row's menu moves it to one, out of them, or into a new
// one you name; dragging it onto a section's label or one of its chats moves it there too, and onto a chat in none
// takes it out, the held row saying where it would go where its time was. A label's click (or Enter) folds its section
// to the label alone, which then says how many chats it holds and has a dot while one of them wants you or has a new
// message; the rows under it glide up on the spring, and a chat opened from elsewhere unfolds its own (Shell.tsx).
// Which are folded is this device's (sidebarLayout.ts useFolded). Its menu (right-click, or its ⋯ under the pointer)
// renames the section, moves it up or down, or removes it (its chats go back on top). A pinned chat shows among the pins
// only, and keeps its section.
import { Archive, ArrowRight, Check, ChevronDown, Ellipsis, Pin, Plus, Rows3, Search, Server } from "lucide-react";
import { display } from "../../../shared/shortcuts";
import { openPalette } from "../palette";
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import type { ChatSection } from "../../../shared/contracts";
import type { DataLayer } from "../../src/data/queries";
import { HubScope, useDataLayer, useHub, useHubs } from "../../src/data/react";
import type { HubView } from "../../src/data/hubs";
import { archiveProject, RenameProjectDialog, type ProjectTarget } from "../projects/actions";
import { ContextMenu, ContextMenuCopy, ContextMenuItem, ContextMenuSeparator, cx, isCut, Menu, MenuCheckboxItem, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, observeSize, preloadable, preloadWhenIdle, StateGlyph, toast, Tooltip, useReorder } from "../../ui";
import { ProjectAvatar } from "../projects/ProjectAvatar";
import type { BotIn } from "../../../shared/bot";
import { lineWords } from "../../../shared/rowLine";
import { useHubState } from "./hubFeed";
import { switchHub, useHubSwipe } from "./hubSwipe";
import { useHubRows } from "./hubRows";
import { HUB_COLOR } from "./hubColor";
import { HubText } from "../projects/HubText";
import { projectId, routeOf, type SidebarProject } from "./model";
import type { Routed } from "./navigation";
import { useOfflineAsOf } from "./offline";
import { changePins, inOrder, pinnedAt, PINS_MAX, unpinned } from "./pins";
import { sameProject, type ProjectKey, type Screen } from "./routes";
import { MoveToSection, SectionLabel, SectionNameDialog, type Naming } from "./SectionLabel";
import { addSection, changeSections, moveChat, moveSection, newSectionId, removeSection, renameSection, sectionLines, useSections } from "./sections";
import type { Placed } from "./Shell";
import { holdRows, useHeldRows } from "./sidebarState";
import { foldKey, openHub, setListView, shownRows, SORTS, sortRows, toggleFold, useFolded, useSidebarView, viewedHub, type SidebarSort, type SidebarView } from "./sidebarLayout";
import { HubLines, useHubUpdate } from "./HubStatus";
import { onWeb } from "../../src/web";
import { useCloud } from "../onboarding/cloud";
import { askedOn } from "./workspaceAsk";
import { PlaceIcons, useHubsMark, You } from "./You";
import s from "./sidebar.module.css";

/** New workspace's dialog, loaded on use (it is never in the first chat's load), or once the app is idle on the web. */
const NewWorkspaceDialog = preloadable(() => import("./NewWorkspace").then((m) => m.NewWorkspaceDialog));
if (onWeb()) preloadWhenIdle(NewWorkspaceDialog);
else NewWorkspaceDialog.preload().catch(() => undefined);

/** A chat's picture in its row: big enough to read its face, the row a 46 px rounded box around it. */
const AVATAR = 32;
/** Compact rows' (the ⋯'s Compact rows): one line each. */
const DENSE_AVATAR = 22;
/** A pinned chat's picture, pinColumns to a row, the group centred in the sidebar: a step over a row's, no more. */
const PIN_AVATAR = 36;
/** Three across; four pins as two pairs, so no count leaves a lone pin under a full row of two. */
const pinColumns = (count: number): number => (count === 4 ? 2 : Math.max(1, Math.min(count, 3)));
/** The glide to a new place: the app's spring (--ease-spring, --dur-spring in tokens.css). */
export const SPRING = { ms: 360, ease: "var(--ease-spring)" } as const;

export interface SidebarProps {
  /** Every hub's rows, in sidebar order; undefined while the screen's hub's are loading. */
  readonly projects: ReadonlyArray<Placed> | undefined;
  readonly screen: Routed;
  /** ⌘ (Ctrl) is held: show the jump numbers. */
  readonly jumpHints: boolean;
  /** The rows on show, in order, as the frame counts them for ⌘1–9 (sidebarLayout.ts shownRows); absent, worked out here. */
  readonly shown?: ReadonlyArray<Placed> | undefined;
  /** What it shows (sidebarLayout.ts); absent, the window's. */
  readonly view?: SidebarView | undefined;
  /** The hub on show (sidebarLayout.ts viewedHub); absent, the screen's. */
  readonly hub?: string | undefined;
  /** The hub reports metrics (or hasn't said yet): the Factory opens on Output, else on Agent time. */
  readonly factory: boolean;
  readonly go: (screen: Screen) => void;
}

const UNREAD = "New message from the lead";

/** Search, as a field: it opens the palette, which finds chats, agents and commands. */
const SearchField = () => (
  <button type="button" className={s.search} aria-label="Search" aria-keyshortcuts={display("palette.toggle", window.fleetd.platform)} onClick={() => openPalette()}>
    <Search aria-hidden />
    <span className={s.searchWord}>Search</span>
    <kbd className={s.searchKey}>{display("palette.toggle", window.fleetd.platform)}</kbd>
  </button>
);

/**
 * The list's ⋯: how the hub's bots are ordered and drawn (sidebarLayout.ts), kept on this computer, and where the
 * archived ones are. View options, not settings.
 */
function ListMenu({ go }: { go: (screen: Screen) => void }) {
  const view = useSidebarView();
  return (
    <Menu>
      <Tooltip content="View options">
        <MenuTrigger asChild>
          <button type="button" className={s.new} aria-label="View options" data-opens="list-menu">
            <Ellipsis aria-hidden />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent align="end" className={s.listMenu} aria-label="View options">
        <MenuLabel>Sort by</MenuLabel>
        <MenuRadioGroup value={view.sort} onValueChange={(v) => setListView({ sort: v as SidebarSort })}>
          {SORTS.map((o) => (
            <MenuRadioItem key={o.id} value={o.id}>
              {o.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuCheckboxItem icon={<Rows3 aria-hidden />} checked={view.compact} onCheckedChange={(on) => setListView({ compact: on })} onSelect={(e) => e.preventDefault()}>
          Compact rows
        </MenuCheckboxItem>
        <MenuItem icon={<Archive aria-hidden />} onSelect={() => go({ id: "settings", tab: "projects" })}>
          Archived bots
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/**
 * The sidebar's top, a line of its own under the window's traffic lights (on the web, its first line): the hub on show,
 * which picks another, and the list's ⋯; under it search, as a field, and New bot, a plus at its end.
 */
export function SidebarTop({ go, hub }: { go: (screen: Screen) => void; hub: string }) {
  return (
    <div className={s.sideHead}>
      <div className={s.hubRow}>
        <HubSwitcher hub={hub} />
        <ListMenu go={go} />
      </div>
      <div className={s.topTools}>
        <SearchField />
        <Tooltip content="New bot">
          <button type="button" className={s.new} aria-label="New bot" data-opens="projects.add" onClick={() => go({ id: "projects.add", at: hub })}>
            <Plus aria-hidden />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/** How many of a hub's bots want you: from its own rows, there whether or not the screen's hub has loaded its own. */
const wantingOn = (rows: ReturnType<typeof useHubRows>, hub: string): number => rows.get(hub)?.projects?.filter((p) => p.want !== undefined).length ?? 0;

/** A hub's mark: its first letter on its colour, a small square (the hub's own shape; a bot's is round). */
export function HubMark({ hub, size = 20 }: { hub: Pick<HubView, "label" | "color">; size?: number }) {
  return (
    <span className={s.hubMark} style={{ "--hub": hub.color === undefined ? "var(--text)" : HUB_COLOR[hub.color], "--size": `${String(size)}px` } as CSSProperties} aria-hidden>
      {Array.from(hub.label.trim())[0]?.toUpperCase() ?? "·"}
    </span>
  );
}

/**
 * The hub row's switcher: the workspace on show, its name strong; a click lists every workspace this app knows (all of
 * the account's cloud ones, and on the desktop each self-hosted one paired) as a menu, the one on show ticked and a dot
 * by each where a bot wants you, and under each what is off with it (can't reach it, a machine to look at, setup left)
 * with the one thing to do (HubStatus.tsx HubLines). A pick switches at once: each keeps its own data layer, so its
 * chats and screens are as it left them. Workspaces live here, not in the menu under your name. At its foot New
 * workspace (NewWorkspace.tsx), an empty cloud one of your own; with no cloud workspace yet, the desktop's sign-in, which
 * makes a first; and on the desktop, Connect a self-hosted workspace.
 */
function HubSwitcher({ hub: id }: { hub: string }) {
  const hubs = useHubs();
  const rows = useHubRows();
  const cloud = useCloud().state.available || onWeb();
  const [making, setMaking] = useState(false);
  // The dialog mounts once first asked for, and stays, so it closes as it opened.
  const [asked, setAsked] = useState(false);
  // Something is off with a hub, its update waits on someone, or another hub wants you: the switcher says so, quietly,
  // without opening.
  const off = useHubsMark();
  const update = useHubUpdate();
  const hub = hubs.find((h) => h.id === id) ?? hubs[0];
  if (hub === undefined) return null;
  const elsewhere = hubs.some((h) => h.id !== hub.id && wantingOn(rows, h.id) > 0);
  const from = askedOn(hubs, hub.id);
  const connect = () => (window.location.hash = "#/onboarding?add");
  return (
    <>
      <Menu>
        <Tooltip content={off?.why ?? update ?? undefined}>
          <MenuTrigger asChild>
            <button type="button" className={s.switcher} aria-label={[hub.label, elsewhere ? "another workspace needs you" : null, off?.why, update].filter((w) => w != null).join(", ")} data-opens="hubs" data-mark={off?.tone}>
              <HubMark hub={hub} size={20} />
              <span className={s.switcherName}>{hub.label}</span>
              <ChevronDown className={s.switcherChevron} aria-hidden />
              {elsewhere || off !== null || update !== null ? <span className={s.dot} data-want="you" data-tone={off?.tone} aria-hidden /> : null}
            </button>
          </MenuTrigger>
        </Tooltip>
        <MenuContent align="start" className={s.hubCard} aria-label="Workspaces">
          <MenuLabel>Workspaces</MenuLabel>
          {hubs.map((h) => (
            <HubScope key={h.id} hub={h}>
              <MenuItem icon={<HubMark hub={h} size={18} />} hint={h.id === hub.id ? <Check className={s.hubItemCheck} aria-hidden /> : wantingOn(rows, h.id) > 0 ? <span className={s.dot} data-want="you" aria-label="A bot needs you" /> : undefined} onSelect={() => openHub(h.id)}>
                {h.label}
              </MenuItem>
              <HubLines />
            </HubScope>
          ))}
          <MenuSeparator />
          {cloud ? (
            <MenuItem icon={<Plus aria-hidden />} data-opens="workspace.new" onSelect={() => (from === null ? connect() : (setAsked(true), setMaking(true)))}>
              New workspace…
            </MenuItem>
          ) : null}
          {onWeb() ? null : (
            <MenuItem icon={<Server aria-hidden />} onSelect={connect}>
              Connect a self-hosted workspace…
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      {from === null || !asked ? null : (
        <Suspense fallback={null}>
          <NewWorkspaceDialog from={from} open={making} onClose={() => setMaking(false)} />
        </Suspense>
      )}
    </>
  );
}

/**
 * whenShort's formatters, each made once: toLocaleTimeString with options makes a new one per call, which costs far
 * more than formatting with it, and every row asks on each render of the sidebar (the start renders it several times).
 */
const WHEN_FORMATS = {
  clock: { hour: "numeric", minute: "2-digit" },
  weekday: { weekday: "short" },
  date: { day: "numeric", month: "short" },
  dateYear: { day: "numeric", month: "short", year: "2-digit" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;
const whenFormatters = new Map<keyof typeof WHEN_FORMATS, Intl.DateTimeFormat>();
const whenFormat = (kind: keyof typeof WHEN_FORMATS, at: Date): string => {
  let f = whenFormatters.get(kind);
  if (f === undefined) {
    f = new Intl.DateTimeFormat(undefined, WHEN_FORMATS[kind]);
    whenFormatters.set(kind, f);
  }
  return f.format(at);
};

/** When a line was written, as a chats list says it: "09:14" today, "Yesterday", "Tue" this week, else "3 Nov". */
export const whenShort = (iso: string, now = new Date()): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return whenFormat("clock", at);
  if (days === 1) return "Yesterday";
  if (days < 7) return whenFormat("weekday", at);
  return whenFormat(at.getFullYear() === now.getFullYear() ? "date" : "dateYear", at);
};

/** The row's one mark: a dot for a new message, else a red main. What waits on you and what works, its line and its bot
 * say (W950): the bot hops while it needs you and moves while it works, at any size. */
const mark = (p: SidebarProject): { readonly node: ReactNode; readonly tip: string } | null => {
  if (p.unread) return { node: <span className={s.dot} aria-hidden />, tip: UNREAD };
  // It stops nothing, so the word without the weight that asks for you.
  if (p.warning !== undefined) return { node: <span className={s.red}>CI red</span>, tip: p.warning };
  return null;
};

/** What the row knows of its bot beyond the project's row: why it wants you, and a reply you haven't seen. */
const botOwn = (p: SidebarProject): Partial<BotIn> => ({ needs: p.want !== undefined && p.want.word !== "blocked", blocked: p.want?.word === "blocked", done: p.unread });

/** The row's line, as words: what waits on you, "Working…", its lead's status line, or its newest (shared/rowLine.ts). */
const lineOf = (p: SidebarProject): string => lineWords(p.say);

/** The row's line, drawn: what to do a step stronger, in the line's tone. */
function Line({ p }: { readonly p: SidebarProject }) {
  return (
    <span className={s.line} data-tone={p.say.tone} data-empty={p.line === "" && p.say.tone === undefined && p.status === undefined ? true : undefined}>
      {p.say.lead === undefined ? null : <span className={s.lineLead}>{p.say.lead} </span>}
      <HubText>{p.say.text}</HubText>
    </span>
  );
}

interface RowProps extends Omit<ComponentProps<"button">, "children"> {
  readonly p: SidebarProject;
  readonly current: boolean;
  readonly jump: number | null;
  readonly asOf: string | undefined;
  /** Held over one of your sections or a chat in none, where it would go if let go, shown where the time is. */
  readonly into?: string | undefined;
  readonly avatar?: number | undefined;
  /** Compact: one line, the picture, the name and the mark; the time and the line are in the row's description. */
  readonly dense?: boolean | undefined;
}

/** One chat's row: picture, name and time, then its line and its mark. The menu's trigger props go on its button. */
function Row({ p, current, jump, asOf, into, avatar = AVATAR, dense = false, ...rest }: RowProps) {
  const m = mark(p);
  // Offline the marks are the last known ones, and their words say since when ("as of 09:02").
  const tip = m === null || asOf === undefined ? m?.tip : `${m.tip}, ${asOf}`;
  if (dense) {
    return (
      <button
        type="button"
        className={cx(s.row, s.dense)}
        {...(current ? { "aria-current": "page" as const } : {})}
        data-unread={p.unread || undefined}
        aria-description={[tip, lineOf(p), whenShort(p.at)].filter((w) => w !== undefined && w !== "").join(", ")}
        {...rest}
      >
        <ProjectAvatar project={p.project} size={DENSE_AVATAR} own={botOwn(p)} className={s.avatar} />
        <span className={s.name}>{p.project.title}</span>
        {into !== undefined ? (
          <span className={s.into}>
            <ArrowRight aria-hidden />
            <span>{into}</span>
          </span>
        ) : jump !== null ? (
          <span className={s.jump}>{jump}</span>
        ) : m === null ? null : (
          <Tooltip content={tip === undefined ? undefined : <HubText>{tip}</HubText>}>
            <span className={s.mark}>{m.node}</span>
          </Tooltip>
        )}
      </button>
    );
  }
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
      <ProjectAvatar project={p.project} size={avatar} own={botOwn(p)} className={s.avatar} />
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
          <Line p={p} />
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

export function Sidebar({ projects, screen, jumpHints, factory, go, ...given }: SidebarProps) {
  const hubs = useHubs();
  const windowView = useSidebarView();
  const view = given.view ?? windowView;
  const hub = given.hub ?? viewedHub(view, hubs, screen.at);
  const folded = useFolded();
  const held = useHeldRows() !== null;
  const shown = given.shown ?? (projects === undefined ? undefined : shownRows(projects, view, hub, folded, held));
  const loaded = useHubRows();
  const jumpOf = (p: Placed): number | null => {
    const at = shown?.indexOf(p) ?? -1;
    return jumpHints && at >= 0 && at < 9 ? at + 1 : null;
  };
  // Nothing outlives the sidebar holding its rows.
  useEffect(() => () => holdRows(null), []);
  // Held as drawn: each hub's rows on show in the list's order (the ones that want you first), then the rest.
  const keys = useMemo(() => {
    if (projects === undefined) return undefined;
    const drawn = hubs.flatMap((h) => shownRows(projects, view, h.id, folded, held));
    const at = new Set(drawn);
    return [...drawn, ...projects.filter((p) => !at.has(p))].map((p) => p.key);
  }, [projects, hubs, view, folded, held]);
  const shownHub = hubs.find((h) => h.id === hub) ?? hubs[0];
  const openOn = (id: string): ProjectKey | null => (screen.id === "project" && screen.at === id ? screen.project : null);
  const hold = { onPointerEnter: () => holdRows(keys ?? null), onPointerLeave: () => holdRows(null) };
  // A hub whose projects haven't loaded (offline from the start, say) waits on its own.
  const waitsOn = (h: HubView): boolean => projects === undefined || (loaded.has(h.id) && loaded.get(h.id)?.projects === undefined);
  const group = (h: HubView, jump: (p: Placed) => number | null) => (
    <HubScope key={h.id} hub={h}>
      <ProjectGroup rows={waitsOn(h) ? undefined : projects?.filter((p) => p.hub === h.id)} all={projects?.filter((p) => p.hub === h.id) ?? []} view={view} several={hubs.length > 1} open={openOn(h.id)} jumpOf={jump} go={go} />
    </HubScope>
  );

  // Two fingers across it switch hubs (hubSwipe.ts): the list follows them, the next or previous hub's beside it, and
  // the marks at the foot follow too. The whole sidebar listens, its top included. The hubs either side are drawn
  // ahead, hidden, once the sidebar is idle (W813): a swipe then starts on a list already there, with nothing to render
  // and no frame lost; the swipe asks for any other (a mark further off, or a swipe before then). With reduced motion
  // nothing slides, so nothing is drawn ahead.
  const area = useRef<HTMLElement | null>(null);
  const pane = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const sides = useRef(new Map<number, HTMLDivElement>());
  const marks = useRef<HTMLDivElement>(null);
  const ids = useMemo(() => hubs.map((h) => h.id), [hubs]);
  const at = shownHub === undefined ? -1 : ids.indexOf(shownHub.id);
  const still = useReducedMotion();
  const warm = useIdle(hubs.length > 1 && !still) && !still;
  const { beside, press } = useHubSwipe({
    area,
    pane,
    frame: pages,
    hubs: ids,
    at,
    paint: (offset, by, width) => {
      if (pane.current !== null) pane.current.style.transform = offset === 0 ? "" : `translate3d(${String(offset)}px, 0, 0)`;
      for (const [side, el] of sides.current) {
        const on = by?.side === side;
        el.toggleAttribute("data-shown", on);
        if (on) el.style.transform = `translate3d(${String(offset + side * width)}px, 0, 0)`;
      }
      marks.current?.style.setProperty("--at", String(at - (width > 0 ? offset / width : 0)));
    },
    drawn: (b) => warm && b.to === at + b.side,
  });
  /** The hub drawn on `side`: the one the swipe asked for there, else, once idle, the neighbour. */
  const sideHub = (side: 1 | -1): HubView | undefined => (beside?.side === side ? hubs[beside.to] : warm && at >= 0 ? hubs[at + side] : undefined);
  // Each hub opens at its top, the one slid in as it was drawn beside.
  useLayoutEffect(() => {
    if (pane.current !== null) pane.current.scrollTop = 0;
  }, [shownHub?.id]);

  return (
    <nav
      ref={(el) => {
        area.current = el?.closest<HTMLElement>("#sidebar") ?? el;
      }}
      className={s.sidebar}
      aria-label="Sidebar"
      data-compact={view.compact || undefined}
    >
      <div ref={pages} className={s.pages} {...press}>
        <div ref={pane} className={s.list} {...hold}>
          {shownHub === undefined ? null : group(shownHub, jumpOf)}
        </div>
        {([-1, 1] as const).map((side) => {
          const h = sideHub(side);
          return h === undefined ? null : (
            <div
              key={h.id}
              ref={(el) => {
                if (el === null) sides.current.delete(side);
                else sides.current.set(side, el);
              }}
              className={cx(s.list, s.beside)}
              aria-hidden
              inert
            >
              {group(h, () => null)}
            </div>
          );
        })}
      </div>
      <div className={s.foot}>
        <You go={go} />
        <HubDots ref={marks} at={at} />
        <PlaceIcons screen={screen} factory={factory} go={go} />
      </div>
    </nav>
  );
}

/** The system asks for reduced motion, as it changes. */
const useReducedMotion = (): boolean =>
  useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

/** Whether the window has been idle once since this mounted (with `wanted`): for work that can wait until then. */
const useIdle = (wanted: boolean): boolean => {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (!wanted || idle) return;
    if (typeof requestIdleCallback !== "function") {
      const t = setTimeout(() => setIdle(true), 0);
      return () => clearTimeout(t);
    }
    const id = requestIdleCallback(() => setIdle(true), { timeout: 1000 });
    return () => cancelIdleCallback(id);
  }, [wanted, idle]);
  return idle;
};

/**
 * One small mark a hub at the sidebar's foot, between you and the three icons, the one on show filled; a swipe moves it
 * with the fingers. A click switches to that hub, on the slide. None with one hub. More than the space between holds
 * at their usual pitch close up to fit it, so the icons never move for a hub more.
 */
function HubDots({ ref, at }: { ref: RefObject<HTMLDivElement | null>; at: number }) {
  const hubs = useHubs();
  if (hubs.length < 2) return null;
  return (
    <div className={s.marksSlot}>
      <div ref={ref} className={s.marks} role="group" aria-label="Workspaces" style={{ "--at": String(at), "--hubs": String(hubs.length) } as CSSProperties}>
        {hubs.map((h, i) => (
          <Tooltip key={h.id} content={h.label} side="top">
            <button type="button" className={s.markHub} aria-label={h.label} {...(i === at ? { "aria-current": "true" as const } : {})} onClick={() => switchHub(h.id)} />
          </Tooltip>
        ))}
        <span className={s.markOn} aria-hidden />
      </div>
    </div>
  );
}

/**
 * Changes `layer`'s pins: `how` gets the hub's own (pins.ts), those of `rows`, as row keys, and returns them changed
 * (the same list for no change). The ones on show may not be the hub's yet.
 */
const pin = (layer: DataLayer, rows: ReadonlyArray<Placed>, how: (keys: readonly string[]) => readonly string[]) => {
  const byKey = new Map(rows.map((p) => [p.key, p]));
  void changePins(layer, (now) => {
    const keys = now.map(projectId).filter((k) => byKey.has(k));
    const next = how(keys);
    return next === keys
      ? now
      : next.flatMap((k) => {
          const p = byKey.get(k);
          return p === undefined ? [] : [routeOf(p)];
        });
  });
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
/** The label over the chats in none of your sections: no section has its id. */
const BOTS: ChatSection = { id: "~bots", name: "Bots", chats: [] };

/** A section label's ⋯: the label's own menu (its right-click one), opened under the button. */
const openLabelMenu = (e: ReactMouseEvent<HTMLButtonElement>) => {
  const label = e.currentTarget.closest("[data-section]")?.querySelector("[data-section-label]");
  const box = e.currentTarget.getBoundingClientRect();
  label?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left, clientY: box.bottom + 4 }));
};
/** Where a chat let go on a chat in no section goes: out of its own. No section has this id. */
const NO_SECTION = "";

/** Placeholder rows while the chats load: their shapes, still, so nothing repaints. */
const Loading = ({ busy }: { busy: boolean }) => (
  <div className={s.loading} aria-busy={busy} aria-label="Loading bots">
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
 * A bot's menu on its own hub (inside its scope): Open, pins, sections, Rename, its settings, Copy path, Archive; and
 * the dialogs it opens. `rows` are the hub's rows, which pin changes are made among.
 */
function useBotMenu(rows: ReadonlyArray<Placed>, at: { at?: string }, go: (screen: Screen) => void) {
  const [renaming, setRenaming] = useState<ProjectTarget | null>(null);
  const [naming, setNaming] = useState<Naming | null>(null);
  const layer = useDataLayer();
  const sections = useSections() ?? NO_SECTIONS;
  // A change is made to the hub's own list (sections.ts), which the ones on show may not be yet.
  const change = (how: (now: readonly ChatSection[]) => readonly ChatSection[]) => void changeSections(layer, how);
  const pinned = rows.filter((p) => p.pinned).map((p) => p.key);
  const pinOn = (key: string, place: number) => {
    if (pinned.length >= PINS_MAX) {
      toast({ title: `Up to ${String(PINS_MAX)} chats can be pinned`, description: "Unpin one to pin this one." });
      return;
    }
    // Before the pin that stands there now, wherever the hub's list has it.
    const before = pinned[place];
    pin(layer, rows, (keys) => pinnedAt(keys, key, before));
  };
  const openRow = (p: SidebarProject) => go({ id: "project", project: routeOf(p), message: null, ...at });
  const menu = (p: Placed) => () => {
    const { machineId, projectId, title, workspaceRoot } = p.project;
    return (
      <>
        <ContextMenuItem onSelect={() => openRow(p)}>Open</ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            if (p.pinned) return pin(layer, rows, (keys) => unpinned(keys, p.key));
            pinOn(p.key, pinned.length);
          }}
        >
          {p.pinned ? "Unpin" : "Pin to top"}
        </ContextMenuItem>
        <MoveToSection sections={sections} chat={routeOf(p)} title={title} onMove={(to) => change((now) => moveChat(now, routeOf(p), to))} onNew={setNaming} />
        <ContextMenuItem onSelect={() => setRenaming({ machineId, projectId, title })}>Rename…</ContextMenuItem>
        {/* Its connections, sign-ins, approvals and the rest are in its settings. */}
        <ContextMenuItem onSelect={() => go({ id: "settings", tab: "projects", for: `${machineId}/${projectId}`, ...at })}>Open settings</ContextMenuItem>
        <ContextMenuCopy text={workspaceRoot}>Copy path</ContextMenuCopy>
        <ContextMenuSeparator />
        {/* Archive keeps everything and shows an Undo; Delete is only in the bot's settings, at the bottom. */}
        <ContextMenuItem onSelect={() => void archiveProject(layer, { machineId, projectId, title })}>Archive</ContextMenuItem>
      </>
    );
  };
  const dialogs = (
    <>
      <RenameProjectDialog project={renaming} onClose={() => setRenaming(null)} />
      <SectionNameDialog
        naming={naming}
        sections={sections}
        onName={(n, name) => change((now) => (n.t === "new" ? addSection(now, newSectionId(), name, n.chat) : renameSection(now, n.section.id, name)))}
        onClose={() => setNaming(null)}
      />
    </>
  );
  return { layer, sections, change, pinned, pinOn, openRow, menu, setNaming, dialogs };
}

/**
 * One hub's chats: its pins, then the chats in none of your sections under a quiet Bots label, then each section under
 * its label, unless folded, each in the list's order (sidebarLayout.ts sortRows).
 */
function ProjectGroup(props: {
  rows: ReadonlyArray<Placed> | undefined;
  all: ReadonlyArray<Placed>;
  view: SidebarView;
  several: boolean;
  open: ProjectKey | null;
  jumpOf: (p: Placed) => number | null;
  go: (screen: Screen) => void;
}) {
  const { rows, open, go } = props;
  const hub = useHub();
  const state = useHubState();
  const asOf = useOfflineAsOf();
  const at = props.several ? { at: hub.id } : {};
  // The hub's own rows, which pins change among.
  const all = props.all;
  const bot = useBotMenu(all, at, go);
  const { layer, sections, change, pinned, pinOn, openRow, menu } = bot;
  // Under the pins: the chats in none of your sections under Bots, then each section's label and its chats.
  const { sort, compact } = props.view;
  const folded = useFolded();
  const held = useHeldRows() !== null;
  const lines = useMemo(() => {
    const below = sectionLines(
      sortRows(
        (rows ?? []).filter((p) => !p.pinned),
        sort,
        held,
      ),
      sections,
      (id) => folded.has(foldKey(hub.id, id)),
    );
    // With sections on show, the chats in none get a label of their own too; with none, no label at all.
    const labelled = below[0]?.t === "chat" && below.some((l) => l.t === "section");
    return labelled ? [{ t: "section" as const, section: BOTS, folded: false, count: 0, dot: undefined }, ...below] : below;
  }, [rows, sections, sort, folded, hub.id, held]);
  // Your sections on show, in order: what a label's Move up and Move down pass (Bots is none of them).
  const labelled = lines.flatMap((l) => (l.t === "section" && l.section !== BOTS ? [l.section.id] : []));
  const rowsByKey = useMemo(() => new Map((rows ?? []).map((p) => [p.key, p])), [rows]);
  const name = (key: string) => rowsByKey.get(key)?.project.title ?? "";
  // The pins lift and move inside their grid, and the hub keeps your order; the other rows' order is their activity's,
  // and they only glide to it. A pin dragged down past them is unpinned; a chat dragged up past the others is pinned
  // where it is let go.
  const grid = useRef<HTMLDivElement>(null);
  const pins = useReorder({
    keys: pinned,
    name,
    onMove: (order) => pin(layer, all, (keys) => inOrder(keys, order)),
    settle: SPRING,
    grid: { columns: pinColumns(pinned.length) },
    out: (key, way) => {
      if (way === "down") pin(layer, all, (keys) => unpinned(keys, key));
    },
  });
  // The labels are among the rows' keys, so they glide and close up with them; only a chat lifts.
  const list = useRef<HTMLDivElement>(null);
  const reorder = useReorder({
    keys: useMemo(() => lines.map((l) => (l.t === "chat" ? l.row.key : labelKey(l.section.id))), [lines]),
    name,
    onMove: () => undefined,
    settle: SPRING,
    fixed: true,
    out: (key, way, place) => {
      if (way === "up") pinOn(key, pinPlace([...(grid.current?.children ?? [])].map((c) => c.getBoundingClientRect()), place));
    },
    // Over another section's label or one of its chats, a chat let go joins that section; over a chat in none (or Bots),
    // it leaves its own.
    ...{
          onto: {
            over: (key: string, point: { x: number; y: number }) => {
              for (const el of list.current?.children ?? []) {
                const box = el.getBoundingClientRect();
                if (!(el instanceof HTMLElement) || el.dataset["lifted"] !== undefined || point.y < box.top || point.y > box.bottom || point.x < box.left || point.x > box.right) continue;
                const to = el.dataset["section"] ?? NO_SECTION;
                return to === (rowsByKey.get(key)?.section ?? NO_SECTION) ? null : to;
              }
              return null;
            },
            drop: (key: string, to: string) => {
              const p = rowsByKey.get(key);
              if (p !== undefined) change((now) => moveChat(now, routeOf(p), to === NO_SECTION ? null : to));
            },
          },
    },
  });
  const labelMenu = (section: ChatSection) => () => {
    const order = labelled;
    const i = labelled.indexOf(section.id);
    return (
      <>
        <ContextMenuItem onSelect={() => bot.setNaming({ t: "rename", section })}>Rename…</ContextMenuItem>
        {/* A move only where there is a section on show to move past. */}
        {i > 0 ? <ContextMenuItem onSelect={() => change((now) => moveSection(now, section.id, -1, order))}>Move up</ContextMenuItem> : null}
        {i < order.length - 1 ? <ContextMenuItem onSelect={() => change((now) => moveSection(now, section.id, 1, order))}>Move down</ContextMenuItem> : null}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => change((now) => removeSection(now, section.id))}
        >
          Remove section
        </ContextMenuItem>
      </>
    );
  };

  return (
    <section className={s.group} aria-label={props.several ? hub.label : "Bots"}>
      {rows === undefined ? (
        // Loading (startup, or a resync after the link dropped): never the "no projects" words, never old rows. Busy
        // only while something is on its way, not while the hub is unreachable.
        <Loading busy={state.phase === "live" || state.phase === "connecting"} />
      ) : rows.length === 0 ? (
        // No bots: nothing here. The main area's one empty state has the one Add a bot (GetStarted), and + is above.
        <div className={s.empty} data-no-bots="" />
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
              style={{ "--pin-cols": pinColumns(pins.shown.length) } as CSSProperties}
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
                const own = line.section !== BOTS;
                return (
                  <div key={labelKey(line.section.id)} ref={ref} style={style} className={s.sectionSlot} data-reorder-row="" {...(own ? { "data-section": line.section.id } : { "data-section-bots": "" })}>
                    {own ? (
                      <>
                        <ContextMenu menu={labelMenu(line.section)}>
                          <SectionLabel line={line} taking={reorder.onto === line.section.id} onClick={() => toggleFold(hub.id, line.section.id)} />
                        </ContextMenu>
                        <span className={s.labelTools}>
                          <Tooltip content="Section options">
                            <button type="button" className={cx(s.new, s.labelTool)} aria-label={`${line.section.name} options`} onClick={openLabelMenu}>
                              <Ellipsis aria-hidden />
                            </button>
                          </Tooltip>
                        </span>
                      </>
                    ) : (
                      <SectionLabel line={line} taking={false} folds={false} />
                    )}
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
                    <Row p={p} current={sameProject(open, p.project)} jump={props.jumpOf(p)} asOf={asOf} into={into} dense={compact} onClick={() => openRow(p)} />
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
      {bot.dialogs}
    </section>
  );
}
