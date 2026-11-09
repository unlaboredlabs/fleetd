// The sidebar's foot (W530): you, and two places to go. Your picture and name open a card with each hub's state (its
// update first, then the link, its machines and version, HubStatus.tsx) and Settings. All being well, that is all it
// says; what is off shows without opening anything, and quietly: an update's one word under your name while it runs
// and a while after (updates/quiet.ts: "Updating…", "Updated", "Put back", or "Update" with one to take), and a small
// mark on your picture while a hub is really unreachable or refused your key (for an admin, also while a machine is
// down or setup steps are left), its words in the tooltip. Screens and Factory are the round buttons beside: Screens
// marked while one needs you.
import { Factory, MonitorSmartphone, Settings } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { HubId } from "../../../shared/hubs";
import { display, type ShortcutId } from "../../../shared/shortcuts";
import { HubScope, useData, useHub, useHubs, useToolQuery } from "../../src/data/react";
import { Avatar, Kbd, Popover, PopoverContent, PopoverTrigger, Tooltip } from "../../ui";
import { useHubRole } from "../admin/role";
import { ForgetHubDialog } from "../settings";
import { UpdateWord, useQuiet } from "../updates";
import { HubCard, linkMark, useAdminMark, type HubMark } from "./HubStatus";
import { useHubState } from "./hubFeed";
import { useHubRows } from "./hubRows";
import type { Screen } from "./routes";
import s from "./sidebar.module.css";

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
  const mark = worst([...useLinkMarks(), useAdminMark()]);
  const [open, setOpen] = useState(false);
  const [forget, setForget] = useState<HubId | null>(null);
  const name = me?.name ?? "You";
  const forgetting = hubs.find((h) => h.id === forget);
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
            <Avatar name={name} size={36} src={picture} />
            <span className={s.youWho}>
              <span className={s.youName}>{name}</span>
              {me === undefined ? null : <span className={s.youRole}>{me.role.charAt(0).toUpperCase() + me.role.slice(1)}</span>}
            </span>
          </div>
          {hubs.map((h) => (
            <HubScope key={h.id} hub={h}>
              <OneHub close={() => setOpen(false)} forget={() => setForget(h.id)} />
            </HubScope>
          ))}
          <div className={s.youMenu}>
            <button
              type="button"
              className={s.youItem}
              data-opens="settings"
              onClick={() => {
                setOpen(false);
                go({ id: "settings", tab: "general" });
              }}
            >
              <Settings aria-hidden />
              <span>Settings</span>
              <Kbd>{display("settings.open", platform)}</Kbd>
            </button>
          </div>
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
      {forgetting === undefined ? null : (
        <HubScope hub={forgetting}>
          <ForgetHubDialog open onOpenChange={(next) => setForget(next ? forget : null)} only={hubs.length === 1} />
        </HubScope>
      )}
    </div>
  );
}

/** One hub's card, in its scope, with its own live state. */
function OneHub({ close, forget }: { close: () => void; forget: () => void }) {
  const hub = useHubState();
  return <HubCard hub={hub} close={close} forget={forget} />;
}
