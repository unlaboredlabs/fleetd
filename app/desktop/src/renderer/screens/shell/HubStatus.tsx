// A hub in the menu under your name (You.tsx; W607): its lines as youMenu.ts words them, each one row. All being
// well that is a dot and the hub's name, which opens Settings › You › Hubs & devices (its address, Pair again, Restart hub and
// Disconnect are there). What is off is one more row each, plain words then the one action a click takes: Retry, Pair
// again, Update, Try again, Open (a machine's page, Hub › Machines › Updates), Finish (Hub › Setup). A row a member can do nothing about ends
// in who to ask and isn't a button. With several hubs each has its rows, its own under the name the person gave it.
// The sidebar has no row for the hub, so the most pressing thing off also marks your avatar (linkMark, useWorkMark).
import { ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import type { HubState } from "../../../shared/hub";
import { useData, useDataLayer, useHub, useSeveralHubs, useToolQuery } from "../../src/data/react";
import { selectMachines } from "../../src/data/selectors";
import { Dot } from "../../ui";
import { useSettledAdministers } from "../admin/role";
import { OPTIONS, openOption } from "../settings";
import { useQuiet, useUpdateAct } from "../updates";
import { navigate } from "./navigation";
import { machinesLine, menuLines, setupLine, workMark, type HubMark, type LineDoes, type LineMark, type MenuMachine } from "./youMenu";
import h from "./hubStatus.module.css";

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

/**
 * One row of the menu: a mark under your picture, words in the name's column, and at its end what a click does (or
 * a quiet word). A button when there is something to do, plain text when not.
 */
export function MenuRow({ mark, end, onClick, name, children, ...rest }: { mark: ReactNode; end?: ReactNode; onClick?: (() => void) | undefined; name?: string | undefined; children: string } & Record<`data-${string}`, string | undefined>) {
  const body = (
    <>
      <span className={h.mark}>{mark}</span>
      <Words name={name}>{children}</Words>
      {end}
    </>
  );
  return onClick === undefined ? (
    <div className={h.row} {...rest}>
      {body}
    </div>
  ) : (
    <button type="button" className={h.row} onClick={onClick} {...rest}>
      {body}
    </button>
  );
}

/** This hub's machines as the menu reads them; undefined until they are known. */
const useMenuMachines = (): readonly MenuMachine[] | undefined => useData(selectMachines)?.map((m) => m.machine);

/** How many of the hub's required setup steps are left, for an admin; 0 for anyone else and a hub before setup steps. */
const useSetupLeft = (admin: boolean): number => {
  const setup = useToolQuery("setup_list", noInput, { enabled: admin });
  return admin ? (setup.data?.requiredLeft ?? 0) : 0;
};

/** What the hub in scope says of its machines and setup, and to whom. */
const useWork = () => {
  const self = useHub();
  const several = useSeveralHubs();
  const admin = useSettledAdministers();
  return { label: several ? self.label : null, admin, machines: useMenuMachines(), setupLeft: useSetupLeft(admin) };
};

/** What else marks your avatar for the hub in scope, while it answers: a machine that needs someone, then setup steps left. */
export const useWorkMark = (): HubMark | null => {
  const { label, admin, machines, setupLeft } = useWork();
  const live = useData((s) => s.hub.phase === "live");
  return live ? workMark([machinesLine(machines, admin), setupLine(setupLeft, admin)], label) : null;
};

/** One hub's rows in the menu under your name, in its scope. `close` shuts the menu. */
export function HubRows({ hub, close }: { hub: HubState; close: () => void }) {
  const work = useWork();
  const quiet = useQuiet(hub);
  // Small and cheap: read on every render, against the clock.
  // eslint-disable-next-line react-hooks/purity
  const lines = menuLines({ hub, quiet, ...work, now: Date.now() });
  const layer = useDataLayer();
  const self = useHub();
  const several = work.label !== null;
  const update = useUpdateAct();
  const act = (does: LineDoes) => {
    // Retry and an update's action change the row where it is; the rest go somewhere.
    if (does.to === "retry") return layer.retryNow();
    if (does.to === "update") return update(does.act);
    close();
    if (does.to === "pair") pair(several ? `#/onboarding?another&at=${self.id}` : "#/onboarding");
    else if (does.to === "setup") navigate({ id: "settings", tab: "hub.setup", at: self.id });
    else if (does.to === "updates") navigate({ id: "settings", tab: "hub.updates", at: self.id });
    else if (does.to === "machines") navigate({ id: "settings", tab: "hub.machines", at: self.id, ...(does.machineId === undefined ? {} : { machine: does.machineId }) });
    else if (HUB_OPTION !== undefined) openOption(several ? { ...HUB_OPTION, key: `hubs.${self.id}` } : HUB_OPTION);
  };

  return (
    <div role="group" className={h.hub} aria-label={several ? self.label : "Hub"} data-hub-card={hub.phase}>
      {lines.map((line) => {
        const { does } = line;
        return (
          <MenuRow
            key={line.key}
            mark={<Mark mark={line.mark} />}
            data-line={line.key}
            data-mark={line.mark}
            name={line.name}
            onClick={does === undefined ? undefined : () => act(does)}
            end={
              line.action !== undefined ? (
                <span className={h.action}>{line.action}</span>
              ) : line.aside !== undefined ? (
                <span className={h.aside}>{line.aside}</span>
              ) : undefined
            }
          >
            {line.text}
          </MenuRow>
        );
      })}
    </div>
  );
}
