// The sidebar's foot (W530, W714): you, and beside you Screens and the Factory, rarely opened, as two small icons,
// Screens marked while one needs you. Your picture and name open your menu: who you are, this app's own update when
// there is one, Settings, Appearance, Keyboard shortcuts and Help; on the web, Sign out. The row is your picture and
// name alone; an update says itself quietly as a small mark on your picture while it runs and a while after, its word
// in the tooltip (updates/quiet.ts: "Updating…", "Updated", "Not updated", or "Update" with one to take). Hubs, and
// what is off with them, are the hub row's (Sidebar.tsx HubSwitcher), which useHubsMark marks.
import { ArrowUpRight, Factory, Keyboard, LifeBuoy, LogOut, Monitor, MonitorSmartphone, Moon, Settings, Sun, SunMoon } from "lucide-react";
import type { ReactNode } from "react";
import { display } from "../../../shared/shortcuts";
import { useData, useHub, useHubs, useToolQuery } from "../../src/data/react";
import { Avatar, Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuTrigger, THEME_MODES, Tooltip, useTheme, type ThemeMode } from "../../ui";
import { openShortcuts } from "../palette/state";
import { onWeb } from "../../src/web";
import { useHubRole } from "../admin/role";
import { useQuiet } from "../updates";
import { AppItem, useWorkMark } from "./HubStatus";
import { useHubState } from "./hubFeed";
import { useHubRows } from "./hubRows";
import type { Screen } from "./routes";
import s from "./sidebar.module.css";
import { linkMark, type HubMark } from "./youMenu";

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

/** Screens on the hub: how many are live and how many ask for you. */
const useScreensCount = () => {
  // The hub feature that brings screens_count (screensPage/data's THUMBS; named here so the shell loads none of the page).
  const served = useData((d) => d.features.includes("screen_thumbs"));
  const count = useToolQuery("screens_count", NO_INPUT, { enabled: served }).data;
  return { asking: count?.asking ?? 0, live: count?.live ?? 0 };
};

/** Screens and the Factory as two small icons beside you, Screens marked while one needs you. */
export function PlaceIcons({ screen, factory, go }: YouProps) {
  const { asking, live } = useScreensCount();
  const mark = asking > 0 ? (asking === 1 ? "one needs you" : `${String(asking)} need you`) : undefined;
  const side = "top";
  return (
    <div className={s.tools}>
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

export interface YouProps {
  readonly screen: Screen;
  /** The hub reports metrics (or hasn't said yet): the Factory opens on Output, else on Agent time. */
  readonly factory: boolean;
  readonly go: (screen: Screen) => void;
}

/**
 * What is off on any hub (a link refused or out of reach; for an admin a machine or setup steps), the most pressing:
 * the hub switcher's mark, since the hubs and what to do about them live there.
 */
export const useHubsMark = (): HubMark | null => worst([...useLinkMarks(), useWorkMark()]);

/**
 * You, at the sidebar's foot: your picture and name, which open your menu (W714): who you are, this app's update when
 * there is one, then Settings, Appearance, Keyboard shortcuts and Help, each shortcut at its row's end; on the web,
 * Sign out. Hubs aren't here: they are the hub row's (Sidebar.tsx HubSwitcher), with what is off with each.
 */
export function You({ go }: Pick<YouProps, "go">) {
  const hub = useHubState();
  const role = useHubRole();
  const me = role.me;
  const picture = usePersonPicture(me?.personId, me?.avatar);
  const quiet = useQuiet(hub);
  const name = me?.name ?? "You";
  const said = [name, quiet === null ? null : quiet.word.text].filter((x) => x != null).join(", ");
  const roleWord = me === undefined ? "" : me.role.charAt(0).toUpperCase() + me.role.slice(1);

  return (
    <div className={s.you}>
      <Menu>
        <Tooltip content={quiet?.word.text}>
          <MenuTrigger asChild>
            <button type="button" className={s.me} aria-label={said} data-opens="you">
              <span className={s.meAvatar}>
                <Avatar name={name} size={24} src={picture} />
                {/* An update going on, in or to take: a small mark, its word in the tooltip and its row in the menu. */}
                {quiet === null ? null : <span className={s.meMark} data-tone="update" aria-hidden />}
              </span>
              <span className={s.meName}>{name}</span>
            </button>
          </MenuTrigger>
        </Tooltip>
        <MenuContent side="top" align="start" className={s.youCard} aria-label="You">
          <MenuLabel className={s.youHead}>
            <Avatar name={name} size={28} src={picture} />
            <span className={s.youWho}>
              <span className={s.youName}>{name}</span>
              {roleWord === "" ? null : <span className={s.youRole}>{roleWord}</span>}
            </span>
          </MenuLabel>
          <MenuSeparator />
          <AppItem />
          <MenuItem icon={<Settings aria-hidden />} hint={display("settings.open", platform)} data-opens="settings" onSelect={() => go({ id: "settings", tab: "general" })}>
            Settings
          </MenuItem>
          <AppearanceSub />
          <MenuItem icon={<Keyboard aria-hidden />} hint={display("shortcuts.show", platform)} onSelect={openShortcuts}>
            Keyboard shortcuts
          </MenuItem>
          <MenuItem icon={<LifeBuoy aria-hidden />} hint={<ArrowUpRight className={s.youOut} aria-hidden />} onSelect={() => void window.fleetd.openExternal(DOCS)}>
            Help & docs
          </MenuItem>
          {onWeb() ? (
            <>
              <MenuSeparator />
              <MenuItem icon={<LogOut aria-hidden />} onSelect={() => void window.fleetd.cloud.signOut().then(() => window.location.assign("/"))}>
                Sign out
              </MenuItem>
            </>
          ) : null}
        </MenuContent>
      </Menu>
    </div>
  );
}

/** Appearance, a row that opens Light, Dark and Match system beside it, the one in use ticked and named at its end. */
function AppearanceSub() {
  const { mode, setMode } = useTheme();
  return (
    <MenuSub icon={<SunMoon aria-hidden />} label="Appearance" hint={THEME_MODES.find((m) => m.value === mode)?.label}>
      <MenuRadioGroup value={mode} onValueChange={(v) => setMode(v as ThemeMode)}>
        {THEME_MODES.map((m) => (
          <MenuRadioItem key={m.value} value={m.value} icon={MODE_ICON[m.value]}>
            {m.label}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuSub>
  );
}

const DOCS = "https://fleetd.sh/docs";

const MODE_ICON: Record<ThemeMode, ReactNode> = { light: <Sun aria-hidden />, dark: <Moon aria-hidden />, system: <Monitor aria-hidden /> };
