import { useMemo } from "react";
import { olderNodes } from "../../../shared/pairing";
import { useData, useDataLayer } from "../../src/data/react";
import { Button, Text } from "../../ui";
import { useCommands } from "../palette";
import { useOfflineAsOf } from "../shell/offline";
import { sentence, type Reaching } from "./form";
import { useHubProbe, useHubState, useReaching, useSecondsUntil } from "./hooks";
import { Prose } from "./Prose";
import s from "./onboarding.module.css";


/**
 * The line the frame shows above any screen while the hub is out of reach, and when a machine needs an update.
 * Offline, the project list and the chats stay on screen marked with the time they were last current (this banner
 * names it too); every other screen shows its skeleton, so nothing held is presented as live.
 */
export function ConnectionBanner() {
  const byId = useData((d) => d.machines);
  const machines = useMemo(() => Object.values(byId), [byId]);
  const state = useHubState();
  const reach = useReaching(state);
  const layer = useDataLayer();
  // Waiting out a retry: an attempt that is running has nothing to hurry.
  const waiting = reach !== null && reach.reason !== null && reach.retryAt !== null;
  useCommands([{ id: "hub.retry", title: "Reconnect now", group: "actions", enabled: () => waiting, run: () => layer.retryNow() }], []);
  const live = state?.phase === "live" ? state.hub : null;
  const probe = useHubProbe(live);
  const behind = probe?.answers === true ? olderNodes(machines, probe.version) : [];
  if (state === null) return null;
  if (reach !== null) return <Reconnecting reach={reach} onRetry={() => layer.retryNow()} />;
  if (behind.length === 0) return null;
  const one = behind.length === 1;
  const names = one ? behind.join("") : `${behind.slice(0, -1).join(", ")} and ${behind.slice(-1).join("")}`;
  return (
    <div className={s.banner} data-tone="quiet" role="status" data-banner="nodes-behind">
      <Prose
        text={`${names} ${one ? "runs" : "run"} an older fleetd than the hub. Run \`fleetd update\` on ${one ? "it" : "each"} so new work can reach ${one ? "it" : "them"}.`}
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
