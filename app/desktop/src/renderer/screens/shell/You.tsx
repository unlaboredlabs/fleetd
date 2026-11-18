// The sidebar's foot (W530): you, and two places to go. Your picture and name open a small menu (W607): who you are,
// a row per hub (a dot and its name, all being well; HubStatus.tsx), this app's own update once below them, and
// Settings. What is off is one more row each, with the one thing to do, and shows without opening anything, quietly:
// an update's one word under your name while it runs and a while after (updates/quiet.ts: "Updating…", "Updated",
// "Not updated", or "Update" with one to take), and a small mark on your picture while a hub is really unreachable or
// refused your key (for an admin, also while a machine is offline or setup steps are left), its words in the tooltip.
// Screens and the Factory, rarely opened, sit low: rows over you (Hubs), round buttons beside you (List) or at the
// rail's foot (Rail), Screens marked while one needs you. The menu also picks the sidebar's layout (sidebarLayout.ts).
import { ChevronsUpDown, Factory, LayoutList, MonitorSmartphone, Settings } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { display, type ShortcutId } from "../../../shared/shortcuts";
import { HubScope, useData, useHub, useHubs, useToolQuery } from "../../src/data/react";
import { Avatar, cx, Kbd, Popover, PopoverContent, PopoverTrigger, Segmented, Tooltip } from "../../ui";
import { useHubRole } from "../admin/role";
import { UpdateWord, useQuiet } from "../updates";
import { AppRow, HubRows, MenuRow, useWorkMark } from "./HubStatus";
import { useHubState } from "./hubFeed";
import { useHubRows } from "./hubRows";
import type { Screen } from "./routes";
import h from "./hubStatus.module.css";
import s from "./sidebar.module.css";
import { linkMark, type HubMark } from "./youMenu";
import { LAYOUTS, setLayout, useSidebarView } from "./sidebarLayout";

const platform = window.fleetd.platform;
const NO_INPUT = {} as const;

/** Your picture's data: URL, undefined while you have none or it loads. */
const usePersonPicture = (personId: string | undefined, avatar: string | undefined): string | undefined => {
  const got = useToolQuery("person_avatar_get", { personId: personId ?? "" }, { enabled: personId !== undefined && avatar !== undefined, keepPrevious: true });
  return avatar === undefined || got.data === undefined ? undefined : `data:${got.data.mime};base64,${got.data.dataB64}`;
};

/** The most pressing of `marks`: a refusal over the rest. */
const worst = (marks: ReadonlyArray<HubMark | null>): HubMark | null =>
  marks.find((m) => m?.tone === "danger") ?? marks.find((m) => m !== null) ?? null;

/** Each hub's link mark, from what every hub's watcher publishes, the frame's own hub from its live state. */
const useLinkMarks = (): ReadonlyArray<HubMark | null> => {
  const hubs = useHubs();
  const rows = useHubRows();
  const self = useHub();
  const here = useHubState();
  const several = hubs.length > 1;
  return hubs.map((h) => {
    const state = h.id === self.id ? here : rows.get(h.id)?.state;
    return state === undefined ? null : linkMark(state, several ? h.label : null);
  });
};

/** A place to go, at the sidebar's top under search: its icon and its word, a dot at the row's end while it needs you. */
function Place(props: { label: string; shortcut?: ShortcutId; current: boolean; mark?: string | undefined; onClick: () => void; children: ReactNode; opens?: string; aside?: string | undefined }) {
  const tip = props.mark ?? props.label;
  return (
    <Tooltip content={props.shortcut === undefined ? props.mark : <>{tip} <Kbd>{display(props.shortcut, platform)}</Kbd></>} side="right">
      <button
        type="button"
        className={s.place}
        aria-label={`${props.label}${props.aside === undefined ? "" : ` · ${props.aside}`}${props.mark === undefined ? "" : `: ${props.mark}`}`}
        {...(props.current ? { "aria-current": "page" as const } : {})}
        data-opens={props.opens}
        onClick={props.onClick}
      >
        {props.children}
        <span className={s.placeLabel}>{props.label}</span>
        {props.aside === undefined ? null : <span className={s.placeAside}>{props.aside}</span>}
        {props.mark === undefined ? null : <span className={s.dot} data-want="you" aria-hidden />}
      </button>
    </Tooltip>
  );
}

/**
 * Screens (D305): marked while one asks for you. One hub-wide count (screens_count, read again on each screen's
 * event), never a project's list.
 */
function ScreensButton({ current, go }: { current: boolean; go: (screen: Screen) => void }) {
  const { asking, live } = useScreensCount();
  return (
    <Place label="Screens" aside={live > 0 ? `${String(live)} live` : undefined} current={current} mark={asking > 0 ? (asking === 1 ? "one needs you" : `${String(asking)} need you`) : undefined} onClick={() => go({ id: "screens", open: null })}>
      <MonitorSmartphone aria-hidden />
    </Place>
  );
}

/** Screens on the hub: how many are live and how many ask for you. */
const useScreensCount = () => {
  // The hub feature that brings screens_count (screensPage/data's THUMBS; named here so the shell loads none of the page).
  const served = useData((d) => d.features.includes("screen_thumbs"));
  const count = useToolQuery("screens_count", NO_INPUT, { enabled: served }).data;
  return { asking: count?.asking ?? 0, live: count?.live ?? 0 };
};

/** Screens and the Factory as two round icons (List: beside you; Rail: at its foot), Screens marked while one needs you. */
export function PlaceIcons({ screen, factory, go, vertical = false }: YouProps & { vertical?: boolean }) {
  const { asking, live } = useScreensCount();
  const mark = asking > 0 ? (asking === 1 ? "one needs you" : `${String(asking)} need you`) : undefined;
  const side = vertical ? "right" : "top";
  return (
    <div className={cx(s.tools, vertical && s.toolsVertical)}>
      <Tooltip content={`Screens${live > 0 ? ` · ${String(live)} live` : ""}${mark === undefined ? "" : `: ${mark}`}`} side={side}>
        <button
          type="button"
          className={s.round}
          aria-label={`Screens${live > 0 ? ` · ${String(live)} live` : ""}${mark === undefined ? "" : `: ${mark}`}`}
          {...(screen.id === "screens" ? { "aria-current": "page" as const } : {})}
          onClick={() => go({ id: "screens", open: null })}
        >
          <MonitorSmartphone aria-hidden />
          {mark === undefined ? null : <span className={s.roundMark} aria-hidden />}
        </button>
      </Tooltip>
      <Tooltip content={factory ? <>Factory <Kbd>{display("factory.open", platform)}</Kbd></> : "Factory"} side={side}>
        <button
          type="button"
          className={s.round}
          aria-label="Factory"
          {...(screen.id === "factory" || screen.id === "time" ? { "aria-current": "page" as const } : {})}
          onClick={() => go(factory ? { id: "factory", project: null } : { id: "time", orderId: null })}
        >
          <Factory aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}

/** The sidebar's places, low in Hubs, over you: Screens and the Factory, each a row with its word. */
export function Places({ screen, factory, go }: YouProps) {
  return (
    <div className={s.places}>
      <ScreensButton current={screen.id === "screens"} go={go} />
      <Place
        label="Factory"
        // A hub from before metrics has no ⌘; (factory/support.ts).
        {...(factory ? { shortcut: "factory.open" as const } : {})}
        current={screen.id === "factory" || screen.id === "time"}
        onClick={() => go(factory ? { id: "factory", project: null } : { id: "time", orderId: null })}
      >
        <Factory aria-hidden />
      </Place>
    </div>
  );
}

export interface YouProps {
  readonly screen: Screen;
  /** The hub reports metrics (or hasn't said yet): the Factory opens on Output, else on Agent time. */
  readonly factory: boolean;
  readonly go: (screen: Screen) => void;
}

/** The menu's layout row: the sidebar's three layouts, the one in use pressed. A pick applies at once and closes the menu. */
function LayoutPick({ close }: { close: () => void }) {
  const { layout } = useSidebarView();
  return (
    <div className={cx(h.row, s.layoutRow)} data-line="layout">
      <span className={h.mark}>
        <LayoutList aria-hidden />
      </span>
      <span className={h.words}>Sidebar</span>
      <Segmented
        label="Sidebar layout"
        options={LAYOUTS.map((l) => ({ value: l.id, label: l.label }))}
        value={layout}
        onChange={(next) => {
          setLayout(next);
          close();
        }}
      />
    </div>
  );
}

/** You, at the sidebar's foot: your picture and name (`compact`, Rail's: the picture alone), which open your menu. */
export function You({ go, compact = false, chevron = true }: Pick<YouProps, "go"> & Partial<YouProps> & { compact?: boolean; chevron?: boolean }) {
  const hubs = useHubs();
  const hub = useHubState();
  const role = useHubRole();
  const me = role.me;
  const picture = usePersonPicture(me?.personId, me?.avatar);
  const quiet = useQuiet(hub);
  const mark = worst([...useLinkMarks(), useWorkMark()]);
  const [open, setOpen] = useState(false);
  // The hubs whose rows offer their whole update, which ends in this app's restart: its own row waits meanwhile.
  const [whole, setWhole] = useState<ReadonlySet<string>>(() => new Set());
  const offers = useCallback((id: string, on: boolean) => setWhole((was) => (was.has(id) === on ? was : on ? new Set([...was, id]) : new Set([...was].filter((h) => h !== id)))), []);
  const name = me?.name ?? "You";
  const said = [name, quiet === null ? null : quiet.word.text, mark?.why].filter((x) => x != null).join(", ");

  return (
    <div className={cx(s.you, compact && s.youCompact)}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip content={mark?.why}>
          <PopoverTrigger asChild>
            <button type="button" className={cx(s.me, compact && s.meCompact)} aria-label={said} data-opens="you" data-mark={mark?.tone}>
              <span className={s.meAvatar}>
                <Avatar name={name} size={compact ? 28 : 32} src={picture} />
                {mark === null ? null : <span className={s.meMark} data-tone={mark.tone} aria-hidden />}
              </span>
              {compact ? null : (
              <span className={s.meText}>
                <span className={s.meName}>{name}</span>
                {quiet === null ? (
                  <span className={s.meRole}>{[me === undefined ? "" : me.role.charAt(0).toUpperCase() + me.role.slice(1), hubs.length === 1 ? (hubs[0]?.label ?? "") : `${String(hubs.length)} hubs`].filter((w) => w !== "").join(" · ")}</span>
                ) : (
                  <span className={s.meWord}>
                    <UpdateWord quiet={quiet} />
                  </span>
                )}
              </span>
              )}
              {compact || !chevron ? null : <ChevronsUpDown className={s.meChevron} aria-hidden />}
            </button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent side={compact ? "right" : "top"} align={compact ? "end" : "start"} className={s.youCard} aria-label="You">
          <div className={s.youHead}>
            <Avatar name={name} size={32} src={picture} />
            <span className={s.youWho}>
              <span className={s.youName}>{name}</span>
              {me === undefined ? null : <span className={s.youRole}>{me.role.charAt(0).toUpperCase() + me.role.slice(1)}</span>}
            </span>
          </div>
          {hubs.map((h) => (
            <HubScope key={h.id} hub={h}>
              <OneHub close={() => setOpen(false)} offers={offers} />
            </HubScope>
          ))}
          <AppRow whole={whole.size > 0} />
          <LayoutPick close={() => setOpen(false)} />
          <MenuRow
            mark={<Settings aria-hidden />}
            end={<Kbd>{display("settings.open", platform)}</Kbd>}
            data-opens="settings"
            onClick={() => {
              setOpen(false);
              go({ id: "settings", tab: "general" });
            }}
          >
            Settings
          </MenuRow>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** One hub's rows, in its scope, with its own live state. */
function OneHub({ close, offers }: { close: () => void; offers: (id: string, on: boolean) => void }) {
  const hub = useHubState();
  const { id } = useHub();
  const whole = useCallback((on: boolean) => offers(id, on), [offers, id]);
  return <HubRows hub={hub} close={close} whole={whole} />;
}
