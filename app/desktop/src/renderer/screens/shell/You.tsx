// The sidebar's foot (W530): you, and two places to go. Your picture and name open a small menu (W607): who you are,
// a row per hub (a dot and its name, all being well; HubStatus.tsx) and Settings. What is off is one more row each,
// with the one thing to do, and shows without opening anything, quietly: an update's one word under your name while
// it runs and a while after (updates/quiet.ts: "Updating…", "Updated", "Put back", or "Update" with one to take), and
// a small mark on your picture while a hub is really unreachable or refused your key (for an admin, also while a
// machine is offline or setup steps are left), its words in the tooltip. Screens and Factory are the round buttons
// beside: Screens marked while one needs you.
import { Factory, MonitorSmartphone, Settings } from "lucide-react";
import { useState, type ReactNode } from "react";
import { display, type ShortcutId } from "../../../shared/shortcuts";
import { HubScope, useData, useHub, useHubs, useToolQuery } from "../../src/data/react";
import { Avatar, Kbd, Popover, PopoverContent, PopoverTrigger, Tooltip } from "../../ui";
import { useHubRole } from "../admin/role";
import { UpdateWord, useQuiet } from "../updates";
import { HubRows, MenuRow, useWorkMark } from "./HubStatus";
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

/** A round icon button of the foot: quiet at rest, filled while its screen is on show. */
function Round(props: { label: string; shortcut?: ShortcutId; current: boolean; mark?: string | undefined; onClick: () => void; children: ReactNode; opens?: string }) {
  const tip = props.mark ?? props.label;
  return (
    <Tooltip content={props.shortcut === undefined ? tip : <>{tip} <Kbd>{display(props.shortcut, platform)}</Kbd></>}>
      <button
        type="button"
        className={s.round}
        aria-label={props.mark === undefined ? props.label : `${props.label}: ${props.mark}`}
        {...(props.current ? { "aria-current": "page" as const } : {})}
        data-opens={props.opens}
        onClick={props.onClick}
      >
        {props.children}
        {props.mark === undefined ? null : <span className={s.roundMark} aria-hidden />}
      </button>
    </Tooltip>
  );
}

/**
 * Screens (D305): marked while one asks for you. One hub-wide count (screens_count, read again on each screen's
 * event), never a project's list.
 */
function ScreensButton({ current, go }: { current: boolean; go: (screen: Screen) => void }) {
  // The hub feature that brings screens_count (screensPage/data's THUMBS; named here so the shell loads none of the page).
  const served = useData((d) => d.features.includes("screen_thumbs"));
  const count = useToolQuery("screens_count", NO_INPUT, { enabled: served }).data;
  const asking = count?.asking ?? 0;
  const live = count?.live ?? 0;
  const label = live > 0 ? `Screens · ${String(live)} live` : "Screens";
  return (
    <Round label={label} current={current} mark={asking > 0 ? (asking === 1 ? "one needs you" : `${String(asking)} need you`) : undefined} onClick={() => go({ id: "screens", open: null })}>
      <MonitorSmartphone aria-hidden />
    </Round>
  );
}

export interface YouProps {
  readonly screen: Screen;
  /** The hub reports metrics (or hasn't said yet): the Factory opens on Output, else on Agent time. */
  readonly factory: boolean;
  readonly go: (screen: Screen) => void;
}

export function You({ screen, factory, go }: YouProps) {
  const hubs = useHubs();
  const hub = useHubState();
  const role = useHubRole();
  const me = role.me;
  const picture = usePersonPicture(me?.personId, me?.avatar);
  const quiet = useQuiet(hub);
  const mark = worst([...useLinkMarks(), useWorkMark()]);
  const [open, setOpen] = useState(false);
  const name = me?.name ?? "You";
  const said = [name, quiet === null ? null : quiet.word.text, mark?.why].filter((x) => x != null).join(", ");

  return (
    <div className={s.foot}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip content={mark?.why}>
          <PopoverTrigger asChild>
            <button type="button" className={s.me} aria-label={said} data-opens="you" data-mark={mark?.tone}>
              <span className={s.meAvatar}>
                <Avatar name={name} size={28} src={picture} />
                {mark === null ? null : <span className={s.meMark} data-tone={mark.tone} aria-hidden />}
              </span>
              <span className={s.meText}>
                <span className={s.meName}>{name}</span>
                {quiet === null ? null : (
                  <span className={s.meWord}>
                    <UpdateWord quiet={quiet} />
                  </span>
                )}
              </span>
            </button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent side="top" align="start" className={s.youCard} aria-label="You">
          <div className={s.youHead}>
            <Avatar name={name} size={32} src={picture} />
            <span className={s.youWho}>
              <span className={s.youName}>{name}</span>
              {me === undefined ? null : <span className={s.youRole}>{me.role.charAt(0).toUpperCase() + me.role.slice(1)}</span>}
            </span>
          </div>
          {hubs.map((h) => (
            <HubScope key={h.id} hub={h}>
              <OneHub close={() => setOpen(false)} />
            </HubScope>
          ))}
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
      <div className={s.tools}>
        <ScreensButton current={screen.id === "screens"} go={go} />
        <Round
          label="Factory"
          // A hub from before metrics has no ⌘; (factory/support.ts).
          {...(factory ? { shortcut: "factory.open" as const } : {})}
          current={screen.id === "factory" || screen.id === "time"}
          onClick={() => go(factory ? { id: "factory", project: null } : { id: "time", orderId: null })}
        >
          <Factory aria-hidden />
        </Round>
      </div>
    </div>
  );
}

/** One hub's rows, in its scope, with its own live state. */
function OneHub({ close }: { close: () => void }) {
  const hub = useHubState();
  return <HubRows hub={hub} close={close} />;
}
