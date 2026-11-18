// The sidebar (W530): your chats, each a row with its picture, its name and its newest line, newest first, and you at
// its foot (You.tsx). New sits at the top, beside the window's controls (NewButton). Your pinned chats stay on top in
// your order (pins.ts): in Hubs up to three to a line, each a picture over its name in a capsule (a name cut short
// shows whole in a tooltip); in List a row of capsules: drag one, or move a focused one with ⌥↑ / ⌥↓, among them; drag a chat up among them to pin it
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
// would go where its time was. A label never folds; its menu renames the section, moves it up or down, or removes it
// (its chats go back on top). A pinned chat shows among the pins only, and keeps its section.
//
// Three layouts carry them (sidebarLayout.ts), none of them stacked groups that fold: List, every bot of every hub in
// one list, each row saying its hub and section; Hubs, one hub at a time, picked at the top; Rail, the hubs down a
// slim rail at the edge. The menu under your name picks one.
import { ArrowRight, Check, ChevronDown, Pin, Plus, Search } from "lucide-react";
import { display } from "../../../shared/shortcuts";
import { openPalette } from "../palette";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import type { ChatSection } from "../../../shared/contracts";
import type { DataLayer } from "../../src/data/queries";
import { HubScope, useDataLayer, useHub, useHubs } from "../../src/data/react";
import type { HubView } from "../../src/data/hubs";
import { archiveProject, RenameProjectDialog, type ProjectTarget } from "../projects/actions";
import { Button, ContextMenu, ContextMenuCopy, ContextMenuItem, ContextMenuSeparator, cx, isCut, observeSize, Popover, PopoverContent, PopoverTrigger, StateGlyph, toast, Tooltip, useReorder } from "../../ui";
import { ProjectAvatar } from "../projects/ProjectAvatar";
import type { BotIn } from "../../../shared/bot";
import { useHubState } from "./hubFeed";
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
import { holdRows } from "./sidebarState";
import { showHub, showSection, shownRows, useSidebarView, viewedHub, type SidebarView } from "./sidebarLayout";
import { Places, PlaceIcons, You } from "./You";
import s from "./sidebar.module.css";

/** A chat's picture in its row: big enough to read its face, the row a 52 px rounded box around it; List's a step
 * smaller, as its rows carry more of them. */
const AVATAR = 36;
const LIST_AVATAR = 32;
/** A pin in List's capsules: the picture beside the name. */
const CAPSULE_AVATAR = 20;
/** Rail's one-line rows. */
const DENSE_AVATAR = 24;
/** A pinned chat's picture, pinColumns to a row, the group centred in the sidebar: a step over a row's, no more. */
const PIN_AVATAR = 40;
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
  /** The layout, and what Hubs and Rail show; absent, the window's. */
  readonly view?: SidebarView | undefined;
  /** The hub Hubs and Rail show (sidebarLayout.ts viewedHub); absent, the screen's. */
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

const NewBot = ({ go }: { go: (screen: Screen) => void }) => (
  <Tooltip content="New bot">
    <button type="button" className={s.new} aria-label="New bot" data-opens="projects.add" onClick={() => go({ id: "projects.add" })}>
      <Plus aria-hidden />
    </button>
  </Tooltip>
);

/**
 * The sidebar's top row, beside the window's controls. List and Rail: search as a field, and New. Hubs: the hub on
 * show, which picks another, then search and New as two icons.
 */
export function SidebarTop({ go, view, hub, projects }: { go: (screen: Screen) => void; view: SidebarView; hub: string; projects: ReadonlyArray<Placed> | undefined }) {
  if (view.layout !== "hubs") {
    return (
      <>
        <SearchField />
        <NewBot go={go} />
      </>
    );
  }
  return (
    <>
      <HubSwitcher hub={hub} projects={projects} />
      <Tooltip content={<>Search <kbd className={s.searchKey}>{display("palette.toggle", window.fleetd.platform)}</kbd></>}>
        <button type="button" className={s.new} aria-label="Search" aria-keyshortcuts={display("palette.toggle", window.fleetd.platform)} onClick={() => openPalette()}>
          <Search aria-hidden />
        </button>
      </Tooltip>
      <NewBot go={go} />
    </>
  );
}

/** How many of a hub's bots want you. */
const wantingOn = (projects: ReadonlyArray<Placed> | undefined, hub: string): number => projects?.filter((p) => p.hub === hub && p.want !== undefined).length ?? 0;

/** A hub's mark: its first letter on its colour, a small square (the hub's own shape; a bot's is round). */
export function HubMark({ hub, size = 20 }: { hub: Pick<HubView, "label" | "color">; size?: number }) {
  return (
    <span className={s.hubMark} style={{ "--hub": hub.color === undefined ? "var(--text)" : HUB_COLOR[hub.color], "--size": `${String(size)}px` } as CSSProperties} aria-hidden>
      {Array.from(hub.label.trim())[0]?.toUpperCase() ?? "·"}
    </span>
  );
}

/** Hubs' top: the hub on show, its name strong; a click lists every hub, a dot by each where a bot wants you. */
function HubSwitcher({ hub: id, projects }: { hub: string; projects: ReadonlyArray<Placed> | undefined }) {
  const hubs = useHubs();
  const [open, setOpen] = useState(false);
  const hub = hubs.find((h) => h.id === id) ?? hubs[0];
  if (hub === undefined) return null;
  // Another hub wants you: the switcher says so, quietly, without opening.
  const elsewhere = hubs.some((h) => h.id !== hub.id && wantingOn(projects, h.id) > 0);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={s.switcher} aria-label={`${hub.label}${elsewhere ? ", another hub needs you" : ""}`} data-opens="hubs">
          <HubMark hub={hub} />
          <span className={s.switcherName}>{hub.label}</span>
          {hubs.length > 1 ? <ChevronDown className={s.switcherChevron} aria-hidden /> : null}
          {elsewhere ? <span className={s.dot} data-want="you" aria-hidden /> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className={s.hubCard} aria-label="Hubs">
        {hubs.map((h) => (
          <button
            key={h.id}
            type="button"
            className={s.hubItem}
            {...(h.id === hub.id ? { "aria-current": "true" as const } : {})}
            onClick={() => {
              showHub(h.id);
              setOpen(false);
            }}
          >
            <HubMark hub={h} />
            <span className={s.hubItemName}>{h.label}</span>
            {wantingOn(projects, h.id) > 0 ? <span className={s.dot} data-want="you" aria-hidden /> : null}
            {h.id === hub.id ? <Check className={s.hubItemCheck} aria-hidden /> : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
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
  /** List's mark of where the bot lives: its section's (or hub's) name, before its line. */
  readonly where?: Where | undefined;
  readonly avatar?: number | undefined;
  /** Rail's: one line, the picture, the name and the mark; the time and the line are in the row's description. */
  readonly dense?: boolean | undefined;
}

/** Where a bot lives, as List's row says it: a word, its section's or (with several hubs) its hub's. */
interface Where {
  readonly word: string | undefined;
  readonly tip: string;
}

/** One chat's row: picture, name and time, then its line and its mark. The menu's trigger props go on its button. */
function Row({ p, current, jump, asOf, into, where, avatar = AVATAR, dense = false, ...rest }: RowProps) {
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
          {where?.word === undefined ? null : (
            <span className={s.where} title={where.tip} data-where="">
              <span className={s.whereWord}>{where.word}</span>
            </span>
          )}
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

/**
 * A pin in List: its picture beside its name, strong, in a capsule that takes the shade while open or under the
 * pointer. New, the dot comes before the name (the warning's when it waits on you); with ⌘ held, its jump number.
 */
function PinCapsule({ p, current, jump, asOf, ...rest }: RowProps) {
  const m = mark(p);
  const tip = m === null || asOf === undefined ? m?.tip : `${m.tip}, ${asOf}`;
  const dot = p.want !== undefined ? "want" : p.unread ? "new" : undefined;
  return (
    <button
      type="button"
      className={s.capsule}
      {...(current ? { "aria-current": "page" as const } : {})}
      data-unread={dot !== undefined || undefined}
      aria-description={tip}
      title={p.project.title}
      {...rest}
    >
      <ProjectAvatar project={p.project} size={CAPSULE_AVATAR} own={botOwn(p)} />
      <span className={s.capsuleName}>{p.project.title}</span>
      {jump !== null ? <span className={s.jump}>{jump}</span> : dot !== undefined ? <span className={s.dot} data-want={dot === "want" ? "you" : undefined} aria-hidden /> : null}
    </button>
  );
}

export function Sidebar({ projects, screen, jumpHints, factory, go, ...given }: SidebarProps) {
  const hubs = useHubs();
  const windowView = useSidebarView();
  const view = given.view ?? windowView;
  const hub = given.hub ?? viewedHub(view, hubs, screen.at);
  const shown = given.shown ?? (projects === undefined ? undefined : shownRows(projects, view, hub));
  const loaded = useHubRows();
  const jumpOf = (p: Placed): number | null => {
    const at = shown?.indexOf(p) ?? -1;
    return jumpHints && at >= 0 && at < 9 ? at + 1 : null;
  };
  // Nothing outlives the sidebar holding its rows.
  useEffect(() => () => holdRows(null), []);
  // Held in the order they are on show, so List's keep theirs too.
  const keys = (view.layout === "hubs" ? projects : shown)?.map((p) => p.key);
  const shownHub = hubs.find((h) => h.id === hub) ?? hubs[0];
  const openOn = (id: string): ProjectKey | null => (screen.id === "project" && screen.at === id ? screen.project : null);
  const hold = { onPointerEnter: () => holdRows(keys ?? null), onPointerLeave: () => holdRows(null) };

  if (view.layout === "list") {
    return (
      <nav className={s.sidebar} aria-label="Sidebar" data-layout="list">
        <div className={s.list} {...hold}>
          <ListBots rows={shown} hubs={hubs} openOn={openOn} jumpOf={jumpOf} go={go} />
        </div>
        <div className={s.foot}>
          <You go={go} chevron={false} />
          <PlaceIcons screen={screen} factory={factory} go={go} />
        </div>
      </nav>
    );
  }

  // Hubs and Rail: one hub's bots. A hub whose projects haven't loaded (offline from the start, say) waits on its own.
  const waiting = projects === undefined || shownHub === undefined || (loaded.has(shownHub.id) && loaded.get(shownHub.id)?.projects === undefined);
  const rows = waiting ? undefined : view.layout === "rail" ? shown : projects.filter((p) => p.hub === shownHub.id);
  const group =
    shownHub === undefined ? null : (
      <HubScope key={shownHub.id} hub={shownHub}>
        <ProjectGroup rows={rows} all={projects?.filter((p) => p.hub === shownHub.id) ?? []} flat={view.layout === "rail"} section={view.layout === "rail" ? view.section : null} several={hubs.length > 1} open={openOn(shownHub.id)} jumpOf={jumpOf} go={go} />
      </HubScope>
    );

  if (view.layout === "rail") {
    return (
      <nav className={cx(s.sidebar, s.railed)} aria-label="Sidebar" data-layout="rail">
        <HubRail hub={shownHub?.id ?? hub} projects={projects} screen={screen} factory={factory} go={go} />
        <div className={s.list} {...hold}>
          {group}
        </div>
      </nav>
    );
  }

  return (
    <nav className={s.sidebar} aria-label="Sidebar" data-layout="hubs">
      <div className={s.list} {...hold}>
        {group}
      </div>
      <div className={s.bottomPlaces}>
        <Places screen={screen} factory={factory} go={go} />
      </div>
      <div className={s.foot}>
        <You go={go} />
      </div>
    </nav>
  );
}

/**
 * Rail: your hubs down the sidebar's left edge, each its mark, the one on show in the open rows' box, a dot by another
 * where a bot wants you; Screens, the Factory and you at its foot.
 */
function HubRail({ hub, projects, screen, factory, go }: { hub: string; projects: ReadonlyArray<Placed> | undefined; screen: Routed; factory: boolean; go: (screen: Screen) => void }) {
  const hubs = useHubs();
  return (
    <div className={s.rail}>
      <div className={s.railHubs} role="group" aria-label="Hubs">
        {hubs.map((h) => {
          // The hub on show says what wants you in its own rows; the others, by a dot on their mark.
          const wanting = h.id === hub ? 0 : wantingOn(projects, h.id);
          return (
            <Tooltip key={h.id} content={h.label} side="right">
              <button
                type="button"
                className={s.railHub}
                aria-label={`${h.label}${wanting > 0 ? `: ${wanting === 1 ? "one needs you" : `${String(wanting)} need you`}` : ""}`}
                {...(h.id === hub ? { "aria-current": "true" as const } : {})}
                onClick={() => showHub(h.id)}
              >
                <HubMark hub={h} size={28} />
                {wanting > 0 ? <span className={cx(s.dot, s.railDot)} data-want="you" aria-hidden /> : null}
              </button>
            </Tooltip>
          );
        })}
      </div>
      <div className={s.railFoot}>
        <PlaceIcons screen={screen} factory={factory} go={go} vertical />
        <You go={go} compact />
      </div>
    </div>
  );
}

/**
 * List: the pins of every hub, as capsules, then every other bot newest first, each row saying where it lives in a
 * quiet word: its section's name, or with several hubs its hub's in none; no colour, so the names lead.
 * Each row is in its hub's scope, so its menu pins, moves and renames on its own hub.
 */
function ListBots({ rows, hubs, openOn, jumpOf, go }: { rows: ReadonlyArray<Placed> | undefined; hubs: readonly HubView[]; openOn: (hub: string) => ProjectKey | null; jumpOf: (p: Placed) => number | null; go: (screen: Screen) => void }) {
  const state = useHubState();
  const pinned = useMemo(() => (rows ?? []).filter((p) => p.pinned), [rows]);
  const rest = useMemo(() => (rows ?? []).filter((p) => !p.pinned), [rows]);
  const byHub = useMemo(() => new Map(hubs.map((h) => [h.id, h])), [hubs]);
  const ofHub = useMemo(() => {
    const m = new Map<string, Placed[]>();
    for (const p of rows ?? []) m.set(p.hub, [...(m.get(p.hub) ?? []), p]);
    return m;
  }, [rows]);
  // The rows glide to their new places, as the other layouts' do; none lifts.
  const reorder = useReorder({
    keys: useMemo(() => rest.map((p) => p.key), [rest]),
    name: (key) => rest.find((p) => p.key === key)?.project.title ?? "",
    onMove: () => undefined,
    settle: SPRING,
    fixed: true,
  });
  if (rows === undefined) return <Loading busy={state.phase === "live" || state.phase === "connecting"} />;
  if (rows.length === 0) return <NoBots go={go} at={{}} />;
  const several = hubs.length > 1;
  return (
    <>
      {pinned.length === 0 ? null : (
        <div className={s.capsules} role="group" aria-label="Pinned">
          {pinned.map((p) => {
            const hub = byHub.get(p.hub);
            return hub === undefined ? null : (
              <HubScope key={p.key} hub={hub}>
                <ListBot p={p} hubRows={ofHub.get(p.hub) ?? []} several={several} current={sameProject(openOn(p.hub), p.project)} jump={jumpOf(p)} go={go} pin />
              </HubScope>
            );
          })}
        </div>
      )}
      <div className={s.rows} {...reorder.list}>
        {rest.map((p) => {
          const hub = byHub.get(p.hub);
          return hub === undefined ? null : (
            <div key={p.key} {...reorder.row(p.key)}>
              <HubScope hub={hub}>
                <ListBot p={p} hubRows={ofHub.get(p.hub) ?? []} several={several} current={sameProject(openOn(p.hub), p.project)} jump={jumpOf(p)} go={go} />
              </HubScope>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** One of List's bots, in its hub's scope: a row, or a pin's capsule, with the bot's menu. */
function ListBot({ p, hubRows, several, current, jump, go, pin: asPin = false }: { p: Placed; hubRows: ReadonlyArray<Placed>; several: boolean; current: boolean; jump: number | null; go: (screen: Screen) => void; pin?: boolean }) {
  const hub = useHub();
  const asOf = useOfflineAsOf();
  const bot = useBotMenu(hubRows, several ? { at: hub.id } : {}, go);
  const section = p.section === undefined ? undefined : bot.sections.find((x) => x.id === p.section)?.name;
  const where: Where = {
    word: section ?? (several ? hub.label : undefined),
    tip: [several ? hub.label : undefined, section].filter((w) => w !== undefined).join(" · "),
  };
  return (
    <>
      <ContextMenu menu={bot.menu(p)}>
        {asPin ? (
          <PinCapsule p={p} current={current} jump={jump} asOf={asOf} onClick={() => bot.openRow(p)} />
        ) : (
          <Row p={p} current={current} jump={jump} asOf={asOf} where={where} avatar={LIST_AVATAR} onClick={() => bot.openRow(p)} />
        )}
      </ContextMenu>
      {bot.dialogs}
    </>
  );
}

/** No bots yet: a few quiet words and the way out, where the rows would be. */
const NoBots = ({ go, at }: { go: (screen: Screen) => void; at: { at?: string } }) => (
  <div className={s.empty}>
    <span className={s.emptyTitle}>No chats yet</span>
    <span className={s.emptyText}>A bot is a chat with its own lead: on a GitHub repo, a folder on one of your machines, or nothing at all.</span>
    <Button size="sm" onClick={() => go({ id: "projects.add", ...at })}>
      New bot
    </Button>
  </div>
);

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
 * One hub's chats, Hubs' and Rail's: its pins, then its other chats. In Hubs (not `flat`), the chats in none of your
 * sections, then each section under its quiet label, always open; in Rail (`flat`), the chats on show newest first,
 * your sections as tabs over them (`section` the one picked).
 */
function ProjectGroup(props: {
  rows: ReadonlyArray<Placed> | undefined;
  all: ReadonlyArray<Placed>;
  flat: boolean;
  section: string | null;
  several: boolean;
  open: ProjectKey | null;
  jumpOf: (p: Placed) => number | null;
  go: (screen: Screen) => void;
}) {
  const { rows, flat, open, go } = props;
  const hub = useHub();
  const state = useHubState();
  const asOf = useOfflineAsOf();
  const at = props.several ? { at: hub.id } : {};
  // The hub's own rows, which pins change among; Rail shows a part of them.
  const all = props.all;
  const bot = useBotMenu(all, at, go);
  const { layer, sections, change, pinned, pinOn, openRow, menu } = bot;
  // Under the pins: the chats in none of your sections, then each section's label and its chats; or, flat, the chats.
  const lines = useMemo(
    () =>
      flat
        ? (rows ?? []).filter((p) => !p.pinned).map((row) => ({ t: "chat" as const, row }))
        : sectionLines(
            (rows ?? []).filter((p) => !p.pinned),
            sections,
            () => false,
          ),
    [rows, sections, flat],
  );
  const labelled = lines.flatMap((l) => (l.t === "section" ? [l.section.id] : []));
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
    grid: { columns: flat ? 1 : pinColumns(pinned.length) },
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
    // Over another section's label or one of its chats, a chat let go joins that section; over a chat in none, it
    // leaves its own. Rail has no labels: its rows' menus move them.
    ...(flat
      ? {}
      : {
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
        }),
  });
  const labelMenu = (section: ChatSection) => () => {
    const place = labelled.indexOf(section.id);
    const order = flat ? sections.map((x) => x.id) : labelled;
    const i = flat ? order.indexOf(section.id) : place;
    return (
      <>
        <ContextMenuItem onSelect={() => bot.setNaming({ t: "rename", section })}>Rename…</ContextMenuItem>
        {/* A move only where there is a section on show to move past. */}
        {i > 0 ? <ContextMenuItem onSelect={() => change((now) => moveSection(now, section.id, -1, order))}>Move up</ContextMenuItem> : null}
        {i < order.length - 1 ? <ContextMenuItem onSelect={() => change((now) => moveSection(now, section.id, 1, order))}>Move down</ContextMenuItem> : null}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => {
            if (props.section === section.id) showSection(null);
            change((now) => removeSection(now, section.id));
          }}
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
      ) : rows.length === 0 && props.section === null ? (
        <NoBots go={go} at={at} />
      ) : (
        <>
          {flat ? <RailHead several={props.several} sections={sections} section={props.section} labelMenu={labelMenu} asOf={asOf} /> : null}
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
              className={cx(s.pins, flat && s.pinRows)}
              style={{ "--pin-cols": flat ? 1 : pinColumns(pins.shown.length) } as CSSProperties}
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
                      {flat ? (
                        <Row p={p} current={sameProject(open, p.project)} jump={props.jumpOf(p)} asOf={asOf} dense onClick={() => openRow(p)} />
                      ) : (
                        <PinCell p={p} current={sameProject(open, p.project)} jump={props.jumpOf(p)} asOf={asOf} onClick={() => openRow(p)} />
                      )}
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
                      <SectionLabel line={line} taking={reorder.onto === line.section.id} />
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
                    <Row p={p} current={sameProject(open, p.project)} jump={props.jumpOf(p)} asOf={asOf} into={into} dense={flat} onClick={() => openRow(p)} />
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

/**
 * Rail's head over the hub's bots: with several hubs, the hub's name; and your sections on it as tabs, All first,
 * when there are any. A tab's menu renames, moves or removes its section.
 */
function RailHead({ several, sections, section, labelMenu, asOf }: { several: boolean; sections: readonly ChatSection[]; section: string | null; labelMenu: (section: ChatSection) => () => ReactNode; asOf: string | undefined }) {
  const hub = useHub();
  return (
    <div className={s.railHead}>
      {several ? (
        <div className={s.railTitle}>
          <span className={s.railTitleName}>{hub.label}</span>
          {asOf === undefined ? null : <span className={s.groupAside}>{asOf}</span>}
        </div>
      ) : null}
      {sections.length === 0 ? null : (
        <div className={s.tabs} role="tablist" aria-label="Sections">
          <button type="button" role="tab" className={s.tab} aria-selected={section === null} onClick={() => showSection(null)}>
            All
          </button>
          {sections.map((x) => (
            <ContextMenu key={x.id} menu={labelMenu(x)}>
              <button type="button" role="tab" className={s.tab} aria-selected={section === x.id} onClick={() => showSection(x.id)}>
                {x.name}
              </button>
            </ContextMenu>
          ))}
        </div>
      )}
    </div>
  );
}
