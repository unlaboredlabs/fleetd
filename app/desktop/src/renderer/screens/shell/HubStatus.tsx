// A hub's state, for the card under your name at the sidebar's foot (You.tsx): the sidebar no longer has a row for the
// hub, so all is well says nothing there, and only what is off shows without opening anything (hubMark: a small mark
// on your avatar; an update's one word, updates/quiet.ts, under your name). Opened, each hub has a card: any update
// first (UpdateNote), then where the link stands ("Connected", "Offline", "Key refused", "Updating fleetd…"), what
// to do about it, the address in full, the machines online, protocol and version, and what can be done from here
// (Retry now, Settings › Hubs, Disconnect), each only when it applies. A paired app adds or changes hubs from Settings
// › Hubs, not #/onboarding. With several hubs there is a card per hub, each under its name. For an admin the Machines
// line opens Machines, and machines down or setup steps left mark the avatar too; a member sees the same facts as
// plain text, and only the link's own state marks anything. A cloud machine asleep is at rest, not down.
import type { HubState } from "../../../shared/hub";
import { versionLabel } from "../../../shared/updates";
import { useData, useDataLayer, useHub, useSeveralHubs, useToolQuery } from "../../src/data/react";
import { selectMachines } from "../../src/data/selectors";
import { Button, Dot, Text } from "../../ui";
import { CloudStatus } from "../admin/CloudStatus";
import { useSettledAdministers } from "../admin/role";
import { Prose } from "../onboarding/Prose";
import { OPTIONS, openOption } from "../settings";
import { UpdateNote, useQuiet } from "../updates";
import { connLine, restartOf, type ConnTone } from "./model";
import { navigate } from "./navigation";
import { useOfflineAsOf } from "./offline";
import h from "./hubStatus.module.css";

const TONE: Record<ConnTone, string> = { success: "var(--success)", warning: "var(--warning)", danger: "var(--danger)", quiet: "var(--faint)", restarting: "var(--faint)" };

const HUB_OPTION = OPTIONS.find((o) => o.key === "hubs.hub");

const noInput = {};

/** A plain dot in its state's colour; while the hub restarts, the dot opened to a ring. */
const SoftDot = ({ tone }: { tone: ConnTone }) => (
  <span className={h.dot} style={{ color: TONE[tone] }}>
    {tone === "restarting" ? <span className={h.ring} aria-hidden /> : <Dot color={TONE[tone]} />}
  </span>
);

/** What marks your avatar for one hub: the most pressing thing off, in a few words; null while all is well. */
export interface HubMark {
  readonly tone: "warning" | "danger";
  readonly why: string;
}

/**
 * The link's own mark, which anyone sees: a refused key, or a hub really unreachable (not the first dial, and not a
 * planned restart until it runs into an outage). Pure, so the frame reads it for every hub from its published state.
 */
export const linkMark = (hub: HubState, label: string | null, now = Date.now()): HubMark | null => {
  const of = label === null ? "" : ` (${label})`;
  if (hub.phase === "refused") return { tone: "danger", why: `The hub refused this app's key${of}` };
  const restart = restartOf(hub, now);
  if (restart !== null && restart.phase !== "outage") return null;
  if (hub.phase === "retrying") return { tone: "warning", why: `Offline${of}` };
  return null;
};

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** This hub's machines: how many of its own are down, and the Machines line. */
const useMachines = () => {
  const machines = useData(selectMachines);
  const own = machines?.filter((m) => m.machine.cloud !== true);
  const cloud = (machines?.length ?? 0) - (own?.length ?? 0);
  const down = own?.filter((m) => m.machine.status !== "online").length ?? 0;
  const online = `${String((own?.length ?? 0) - down)} of ${String(own?.length ?? 0)} online${cloud === 0 ? "" : ` · ${String(cloud)} cloud`}`;
  return { known: machines !== undefined, down, online };
};

/** How many of the hub's required setup steps are left, for an admin; 0 for anyone else and a hub before setup steps. */
const useSetupLeft = (admin: boolean): number => {
  const setup = useToolQuery("setup_list", noInput, { enabled: admin });
  return admin ? (setup.data?.requiredLeft ?? 0) : 0;
};

/** An admin's extra mark on this hub (in its scope): machines down, then setup steps left. */
export const useAdminMark = (): HubMark | null => {
  const admin = useSettledAdministers();
  const { down } = useMachines();
  const left = useSetupLeft(admin);
  if (!admin) return null;
  if (down > 0) return { tone: "warning", why: `${plural(down, "machine", "machines")} down` };
  if (left > 0) return { tone: "warning", why: `${plural(left, "setup step", "setup steps")} left` };
  return null;
};

/** One hub's card in the popover under your name, in its scope. `close` shuts the popover; `forget` asks to disconnect. */
export function HubCard({ hub, close, forget }: { hub: HubState; close: () => void; forget: () => void }) {
  const asOf = useOfflineAsOf();
  const conn = connLine(hub, window.fleetd.fixture !== null, asOf);
  const layer = useDataLayer();
  const self = useHub();
  const several = useSeveralHubs();
  const admin = useSettledAdministers();
  const { known, down, online } = useMachines();
  const left = useSetupLeft(admin);
  const quiet = useQuiet(hub);
  const live = hub.phase === "live" ? hub : null;
  const paired = hub.phase !== "unpaired" && window.fleetd.fixture === null;
  const go = (to: Parameters<typeof navigate>[0]) => {
    close();
    navigate(to);
  };

  return (
    <section className={h.card} aria-label={several ? self.label : "Hub"} data-hub-card={hub.phase}>
      {quiet?.note == null ? null : <UpdateNote note={quiet.note} onDetails={() => go({ id: "settings", tab: "hub.updates", at: self.id })} />}
      <div className={h.head}>
        <SoftDot tone={conn.tone} />
        <Text size="sm" strong>
          {several ? `${self.label} · ${conn.status}` : conn.status}
        </Text>
      </div>
      {conn.detail === null ? null : (
        <Text as="p" size="xs" tone="quiet">
          {conn.detail}
        </Text>
      )}
      {/* The hub's fix may name a command in backticks: shown as code. */}
      {conn.fix === null ? null : <Prose size="xs" tone="quiet" text={conn.fix} />}
      <dl className={h.facts}>
        {conn.hub === null ? null : (
          <>
            <dt>Hub</dt>
            <dd>
              <Text size="xs" mono className={h.url}>
                {conn.hub}
              </Text>
            </dd>
          </>
        )}
        {!known ? null : (
          <>
            <dt>Machines</dt>
            <dd data-down={down > 0 || undefined}>
              {admin ? (
                <button type="button" className={h.factLink} data-opens="machines" onClick={() => go({ id: "settings", tab: "hub.machines", at: self.id })}>
                  {online}
                </button>
              ) : (
                online
              )}
            </dd>
          </>
        )}
        {left === 0 ? null : (
          <>
            <dt>Setup</dt>
            <dd>
              <button type="button" className={h.factLink} data-opens="setup" onClick={() => go({ id: "settings", tab: "hub.setup", at: self.id })}>
                {`${plural(left, "step", "steps")} left`}
              </button>
            </dd>
          </>
        )}
        {live === null ? null : (
          <>
            <dt>Version</dt>
            <dd title={live.version} data-version>
              {live.version === undefined ? `Protocol v${String(live.protocol)}` : `fleetd ${versionLabel(live.version)} · v${String(live.protocol)}`}
            </dd>
          </>
        )}
      </dl>
      {/* Cloud machines: what they cost today, why starts wait, and for a member who to ask. Nothing without them. */}
      <CloudStatus />
      {window.fleetd.fixture !== null ? null : (
        <div className={h.actions}>
          {conn.retry ? (
            <Button variant="primary" onClick={() => layer.retryNow()}>
              Retry now
            </Button>
          ) : null}
          {paired ? (
            <Button
              variant="ghost"
              onClick={() => {
                close();
                if (HUB_OPTION !== undefined) openOption(several ? { ...HUB_OPTION, key: `hubs.${self.id}` } : HUB_OPTION);
              }}
            >
              Settings › Hubs
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => {
                close();
                window.location.hash = several ? `#/onboarding?another&at=${self.id}` : "#/onboarding";
              }}
            >
              Pair with a hub
            </Button>
          )}
          {paired ? (
            <Button
              variant="ghost"
              onClick={() => {
                close();
                forget();
              }}
            >
              Disconnect…
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
