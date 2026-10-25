// The sidebar's last line: a small chip naming the hub ("forge") with a soft dot, quiet while all is well and saying
// so when it isn't ("Reconnecting…", "Offline", "Key refused"). Hovering shows the hub's address; clicking (or Enter)
// opens the details: the address in full, the machines online, protocol and version, and what can be done from here
// (Retry now, Hub settings, Disconnect), each only when it applies. A paired app switches hub from Settings' Hub
// section, not #/onboarding: that page sends a connected app straight back to the board.
import { useState } from "react";
import type { HubState } from "../../../shared/hub";
import { useData, useDataLayer } from "../../src/data/react";
import { selectMachines } from "../../src/data/selectors";
import { Button, Dot, Popover, PopoverContent, PopoverTrigger, Text, Tooltip } from "../../ui";
import { Prose } from "../onboarding/Prose";
import { ForgetHubDialog, OPTIONS, openOption } from "../settings";
import { connLine, type ConnTone } from "./model";
import { useOfflineAsOf } from "./offline";
import h from "./hubStatus.module.css";

const TONE: Record<ConnTone, string> = { success: "var(--success)", warning: "var(--warning)", danger: "var(--danger)", quiet: "var(--faint)" };

const pair = () => {
  window.location.hash = "#/onboarding";
};

const HUB_OPTION = OPTIONS.find((o) => o.key === "general.hub");

/** A dot with a faint ring of its own color. */
const SoftDot = ({ tone }: { tone: ConnTone }) => (
  <span className={h.dot} style={{ color: TONE[tone] }}>
    <Dot color={TONE[tone]} />
  </span>
);

export function HubStatus({ hub }: { hub: HubState }) {
  const asOf = useOfflineAsOf();
  const conn = connLine(hub, window.fleetd.fixture !== null, asOf);
  const layer = useDataLayer();
  const machines = useData(selectMachines);
  const [open, setOpen] = useState(false);
  // Controlled, so its content never changes (an empty one would drop the Tooltip and remount the chip): it just
  // stays shut while the popover is open.
  const [tip, setTip] = useState(false);
  const [forget, setForget] = useState(false);
  const live = hub.phase === "live" ? hub : null;
  const paired = hub.phase !== "unpaired" && window.fleetd.fixture === null;
  const name = conn.label === conn.status ? conn.label : `${conn.label}, ${conn.status.toLowerCase()}`;

  return (
    <div className={h.row}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip content={conn.hub ?? conn.detail ?? conn.status} side="right" open={tip && !open} onOpenChange={setTip}>
          <PopoverTrigger asChild>
            <button type="button" className={h.chip} data-hub-status={hub.phase} data-tone={conn.tone} aria-label={`Hub: ${name}`}>
              <SoftDot tone={conn.tone} />
              <span className={h.label}>{conn.label}</span>
            </button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent side="top" align="start" aria-label="Hub">
          <div className={h.card}>
            <div className={h.head}>
              <SoftDot tone={conn.tone} />
              <Text size="sm" strong>
                {conn.status}
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
              {machines === undefined ? null : (
                <>
                  <dt>Machines</dt>
                  <dd>{`${String(machines.filter((m) => m.machine.status === "online").length)} of ${String(machines.length)} online`}</dd>
                </>
              )}
              {live === null ? null : (
                <>
                  <dt>Protocol</dt>
                  <dd>{live.version === undefined ? `v${String(live.protocol)}` : `v${String(live.protocol)} · fleetd ${live.version}`}</dd>
                </>
              )}
            </dl>
            {window.fleetd.fixture !== null ? null : (
              <div className={h.actions}>
                {conn.retry ? (
                  <Button variant="primary" onClick={() => layer.retryNow()}>
                    Retry now
                  </Button>
                ) : null}
                {paired ? (
                  <Button
                    onClick={() => {
                      setOpen(false);
                      if (HUB_OPTION !== undefined) openOption(HUB_OPTION);
                    }}
                  >
                    Hub settings
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={() => {
                      setOpen(false);
                      pair();
                    }}
                  >
                    Pair with a hub
                  </Button>
                )}
                {paired ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setOpen(false);
                      setForget(true);
                    }}
                  >
                    Disconnect…
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <ForgetHubDialog open={forget} onOpenChange={setForget} />
    </div>
  );
}
