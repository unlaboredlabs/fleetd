// A hub's lines in the hub switcher (Sidebar.tsx HubSwitcher; W607, W714): youMenu.ts words them, each one menu row
// under the hub's name. All being well there is none. What is off is one row each, plain words then the one action a
// click takes: Retry, Pair again, Update, Try again, Open (a machine's page, Hub › Machines › Updates), Finish (Hub ›
// Setup). A row a member can do nothing about ends in who to ask and does nothing. This app's own update is no hub's:
// one row in the menu under your name (AppItem). The most pressing thing off also marks the switcher (linkMark,
// useWorkMark).
import { ArrowUp } from "lucide-react";
import { useData, useDataLayer, useHub, useSeveralHubs, useToolQuery } from "../../src/data/react";
import { selectMachines } from "../../src/data/selectors";
import { Dot, MenuItem } from "../../ui";
import { useHubState } from "./hubFeed";
import { useServes, useSettledAdministers } from "../admin/role";
import { OPTIONS, openOption } from "../settings";
import { useQuiet, useUpdateAct } from "../updates";
import { useAppUpdate } from "../updates/state";
import { navigate } from "./navigation";
import { startScreen } from "../start/kept";
import { useStartLeft } from "../start/state";
import { appLine, hostedLine, machinesLine, menuLines, setupLine, updateLine, workMark, type HubMark, type LineDoes, type LineMark, type MenuLine, type MenuMachine } from "./youMenu";
import h from "./hubStatus.module.css";
import { onWeb } from "../../src/web";
import type { SlotHosted } from "../../../shared/contracts";
import { RUNNER_ID } from "../../../shared/providers";

const TONE: Record<Exclude<LineMark, "ring" | "update">, string> = { success: "var(--success)", warning: "var(--warning)", danger: "var(--danger)", quiet: "var(--faint)" };

const HUB_OPTION = OPTIONS.find((o) => o.key === "hubs.hub");

const noInput = {};

/** Pairing has no screen of the frame's: its own route. */
const pair = (hash: string): void => {
  window.location.hash = hash;
};

/** A line's mark: a plain dot in its state's colour, opened to a ring while the hub restarts; an arrow for an update. */
const Mark = ({ mark }: { mark: LineMark }) =>
  mark === "update" ? <ArrowUp aria-hidden /> : mark === "ring" ? <span className={h.ring} aria-hidden /> : <Dot color={TONE[mark]} />;

/** A row's words. A hub's or machine's `name` in them is the one part cut short when the row is too narrow (a label runs to 40 characters), whole on hover; what is wrong always shows. */
function Words({ children, name }: { children: string; name: string | undefined }) {
  const at = name === undefined || name === "" ? -1 : children.indexOf(name);
  if (name === undefined || at < 0) return <span className={h.words}>{children}</span>;
  const before = children.slice(0, at);
  const after = children.slice(at + name.length);
  return (
    <span className={h.named}>
      {before === "" ? null : <span className={h.part}>{before}</span>}
      <span className={h.name} title={name}>
        {name}
      </span>
      {after === "" ? null : <span className={h.part}>{after}</span>}
    </span>
  );
}

/** A line as a menu row: its mark, its words, and its action or quiet word at the end; it does nothing without one. */
function LineItem({ line, act }: { line: MenuLine; act: (does: LineDoes) => void }) {
  const { does } = line;
  return (
    <MenuItem
      icon={<span className={h.mark}>{<Mark mark={line.mark} />}</span>}
      data-line={line.key}
      data-mark={line.mark}
      disabled={does === undefined}
      className={h.line}
      hint={line.action !== undefined ? <span className={h.action}>{line.action}</span> : line.aside !== undefined ? <span className={h.aside}>{line.aside}</span> : undefined}
      onSelect={(e) => {
        if (does === undefined) return;
        // Retry and an update's action change the row where it is: the menu stays open on it.
        if (does.to === "retry" || does.to === "update") e.preventDefault();
        act(does);
      }}
    >
      <Words name={line.name}>{line.text}</Words>
    </MenuItem>
  );
}

/** This app's own update, a row in the menu under your name; nothing while there is none to say. */
export function AppItem() {
  const line = appLine(useAppUpdate());
  const update = useUpdateAct();
  // Its one action is the update's own, which changes the row where it is.
  const act = (does: LineDoes) => {
    if (does.to === "update") update(does.act);
  };
  return line === null ? null : <LineItem line={line} act={act} />;
}

/**
 * The hub in scope's update that needs someone, an owner's or admin's to take or one that didn't go in (youMenu.ts
 * updateLine): the hub switcher's dot, its words in the tooltip; null while there is none.
 */
export const useHubUpdate = (): string | null => updateLine(useQuiet(useHubState(), false))?.text ?? null;

/** This hub's machines as the menu reads them; undefined until they are known. */
const useMenuMachines = (): readonly MenuMachine[] | undefined => useData(selectMachines)?.map((m) => m.machine);

/** The connected hosted providers as the slot board pushes them: their live count and trouble. */
const useHosted = (): readonly SlotHosted[] | undefined => useData((s) => (s.live.slots ?? s.slots)?.hosted);

/** How many of the hub's required setup steps are left, for an admin; 0 for anyone else and a hub before setup steps. */
const useSetupLeft = (admin: boolean): number => {
  const served = useServes("setup_list");
  const steps = admin && served;
  const setup = useToolQuery("setup_list", noInput, { enabled: steps });
  return steps ? (setup.data?.requiredLeft ?? 0) : 0;
};

/** What the hub in scope says of its machines and setup, and to whom. */
const useWork = () => {
  const self = useHub();
  const several = useSeveralHubs();
  const admin = useSettledAdministers();
  // A team on the web is named by its label even alone: its address is fleetd cloud's, not a host of yours.
  return { label: several || onWeb() ? self.label : null, admin, machines: useMenuMachines(), hosted: useHosted(), setupLeft: useSetupLeft(admin) };
};

/** What else marks your avatar for the hub in scope, while it answers: a machine that needs someone, then setup steps left. */
export const useWorkMark = (): HubMark | null => {
  const { label, admin, machines, hosted, setupLeft } = useWork();
  const live = useData((s) => s.hub.phase === "live");
  return live ? workMark([hostedLine(machines, hosted, admin), machinesLine(machines, admin), setupLine(setupLeft, admin)], label) : null;
};

/**
 * The hub in scope's lines under its name in the hub switcher: what is off with it, each with the one thing to do. The
 * hub's own line shows only when it has something to do (Retry, Pair) or to say (Updating…, Updated, Reconnecting…):
 * all well or connecting, its name above says enough.
 */
export function HubLines() {
  const hub = useHubState();
  const work = useWork();
  const quiet = useQuiet(hub, false);
  const startLeft = useStartLeft();
  // Small and cheap: read on every render, against the clock.
  // eslint-disable-next-line react-hooks/purity
  const lines = menuLines({ hub, quiet, ...work, startLeft, now: Date.now() }).filter((l) => !(l.key === "hub" && l.action === undefined && l.aside === undefined));
  const layer = useDataLayer();
  const self = useHub();
  const several = work.label !== null;
  const update = useUpdateAct();
  const act = (does: LineDoes) => {
    if (does.to === "retry") return layer.retryNow();
    if (does.to === "update") return update(does.act);
    if (does.to === "pair" && onWeb()) window.location.assign("/web/sign-in");
    else if (does.to === "pair") pair(several ? `#/onboarding?another&at=${self.id}` : "#/onboarding");
    else if (does.to === "setup") navigate({ id: "settings", tab: "hub.setup", at: self.id });
    else if (does.to === "accounts") navigate({ id: "settings", tab: "accounts", at: self.id });
    else if (does.to === "start") navigate(startScreen(self.id));
    else if (does.to === "updates") navigate({ id: "settings", tab: "hub.updates", at: self.id });
    else if (does.to === "hosted") {
      // The provider's row, in Hub › Machines (admin/HubPages.tsx reveals it); Try again tests its key there too.
      navigate({ id: "settings", tab: "hub.machines", at: self.id, machine: RUNNER_ID });
      if (does.retry !== undefined) void layer.call("sandbox_test", { provider: does.retry }, { timeoutMs: 60_000 });
    } else if (does.to === "machines") navigate({ id: "settings", tab: "hub.machines", at: self.id, ...(does.machineId === undefined ? {} : { machine: does.machineId }) });
    else if (HUB_OPTION !== undefined) openOption(several ? { ...HUB_OPTION, key: `hubs.${self.id}` } : HUB_OPTION);
  };
  return (
    <>
      {lines.map((line) => (
        <LineItem key={line.key} line={line} act={act} />
      ))}
    </>
  );
}
