import type { HubState } from "../../../shared/hub";
import { olderNodes } from "../../../shared/pairing";
import { Text } from "../../ui";
import { useHubProbe, useHubState, useSecondsUntil } from "./hooks";
import { Prose } from "./Prose";
import s from "./onboarding.module.css";

export interface ConnectionBannerProps {
  /** The snapshot's machines, to name nodes running an older fleetd than the hub. */
  readonly machines?: ReadonlyArray<{ readonly name: string; readonly nodeVersion: string }> | undefined;
}

/**
 * The line the frame shows above any screen while the hub is out of reach, and when a machine needs an update.
 * Screens show their own skeletons meanwhile; nothing cached is presented as live.
 */
export function ConnectionBanner({ machines }: ConnectionBannerProps) {
  const state = useHubState();
  const live = state?.phase === "live" ? state.hub : null;
  const probe = useHubProbe(live);
  const behind = machines !== undefined && probe?.answers === true ? olderNodes(machines, probe.version) : [];
  if (state === null) return null;
  if (state.phase === "connecting" || state.phase === "retrying") return <Reconnecting state={state} />;
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

function Reconnecting({ state }: { state: Extract<HubState, { phase: "connecting" | "retrying" }> }) {
  const seconds = useSecondsUntil(state.phase === "retrying" ? state.retryAt : null);
  const when = seconds === null || seconds === 0 ? "Reconnecting…" : `Trying again in ${seconds} s.`;
  return (
    <div className={s.banner} data-tone="warning" role="status" data-banner="reconnecting">
      <Text>
        {state.phase === "retrying" ? `Lost the hub: ${state.reason}` : `Connecting to ${state.hub}.`} {when}
      </Text>
    </div>
  );
}
