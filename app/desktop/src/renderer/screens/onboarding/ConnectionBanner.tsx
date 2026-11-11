import { useMemo } from "react";
import { olderNodes } from "../../../shared/pairing";
import { useData, useDataLayer } from "../../src/data/react";
import { Button, Text } from "../../ui";
import { useNow } from "../live/clock";
import { useCommands } from "../palette";
import { restartOf } from "../shell/model";
import { useOfflineAsOf } from "../shell/offline";
import { sentence, type Reaching } from "./form";
import { useHubProbe, useHubState, useReaching, useSecondsUntil } from "./hooks";
import { Prose } from "./Prose";
import s from "./onboarding.module.css";


/** "a", "a and b", "a, b and c". */
const listed = (names: ReadonlyArray<string>) => (names.length === 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.slice(-1).join("")}`);

/**
 * The line the frame shows above any screen while the hub is out of reach, and when a machine needs an update. A
 * planned restart isn't out of reach until it has run 2 minutes. A machine is named only when it is linked and still
 * behind once the hub's update of it should have ended, never while that update is on its way.
 * Offline, the project list and the chats stay on screen marked with the time they were last current (this banner
 * names it too); every other screen shows its skeleton, so nothing held is presented as live.
 */
export function ConnectionBanner() {
  const byId = useData((d) => d.machines);
  const live = useData((d) => d.live.machines);
  const machines = useMemo(() => Object.values(byId).map((m) => ({ ...m, linkedSince: live[m.machineId]?.linkedSince })), [byId, live]);
  // A machine behind is named once it has been linked a while, its update no longer on its way: read against the clock
  // each minute.
  const nowMs = useNow(machines.some((m) => m.status !== "offline"), 60_000);
  const state = useHubState();
  const reach = useReaching(state);
  const layer = useDataLayer();
  // Waiting out a retry: an attempt that is running has nothing to hurry.
  const waiting = reach !== null && reach.reason !== null && reach.retryAt !== null;
  useCommands([{ id: "hub.retry", title: "Reconnect now", group: "actions", enabled: () => waiting, run: () => layer.retryNow() }], []);
  // The hub's version comes with its `ready`; only an older hub, whose `ready` doesn't say it, is asked on /healthz,
  // a connection of its own.
  const ready = state.phase === "live" ? state.version : undefined;
  const probe = useHubProbe(state.phase === "live" && ready === undefined ? state.hub : null);
  const version = ready ?? (probe?.answers === true ? probe.version : undefined);
  const behind = version === undefined ? [] : olderNodes(machines, version, nowMs);
  // A hub that closed to restart is said by the hub row, then the restart line (shell/RestartLine), until it has
  // been away 2 minutes: an outage from then on. Read against the clock at each redial's state.
  // eslint-disable-next-line react-hooks/purity
  const restart = useMemo(() => restartOf(state, Date.now()), [state]);
  if (restart !== null && restart.phase !== "outage") return null;
  if (reach !== null) return <Reconnecting reach={reach} onRetry={() => layer.retryNow()} />;
  if (behind.length === 0) return null;
  const one = behind.length === 1;
  return (
    <div className={s.banner} data-tone="quiet" role="status" data-banner="nodes-behind">
      <Prose
        text={`${listed(behind)} ${one ? "runs" : "run"} an older fleetd than the hub. Run \`fleetd update\` on ${one ? "it" : "each"} so new work can reach ${one ? "it" : "them"}.`}
      />
    </div>
  );
}

/**
 * One layout for every attempt: only the countdown changes, and Retry now stays put (disabled while an attempt
 * runs), so a fast-failing hub doesn't flash.
 */
function Reconnecting({ reach, onRetry }: { reach: Reaching; onRetry: () => void }) {
  const seconds = useSecondsUntil(reach.retryAt);
  const asOf = useOfflineAsOf();
  const when = seconds === null || seconds === 0 ? "Reconnecting…" : `Trying again in ${seconds} s.`;
  return (
    <div className={s.banner} data-tone="warning" role="status" data-banner="reconnecting">
      {reach.reason === null ? (
        <Text tone="warning">{`Connecting to ${reach.hub}…`}</Text>
      ) : (
        <>
          <div className={s.bannerLine}>
            <Text tone="warning" tabular>{`${asOf === undefined ? "Offline." : `Offline, ${asOf}.`} ${sentence(reach.reason)} ${when}`}</Text>
            <span className={s.bannerAction}>
              <Button variant="secondary" disabled={reach.retryAt === null} onClick={onRetry}>
                Retry now
              </Button>
            </span>
          </div>
          {reach.fix === null ? null : <Prose text={reach.fix} tone="quiet" size="sm" />}
        </>
      )}
    </div>
  );
}
