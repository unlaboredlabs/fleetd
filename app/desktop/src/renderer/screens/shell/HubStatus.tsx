// The sidebar's last line: a row naming the hub ("devbox") beside a plain dot, quiet while all is well and saying
// so when it isn't ("Reconnecting…", "Offline", "Key refused"). Hovering shows the hub's address; clicking (or Enter)
// opens the details: the address in full, the machines online, protocol and version, and what can be done from here
// (Retry now, Settings › Hubs, Disconnect), each only when it applies. A paired app adds or changes hubs from Settings ›
// Hubs, not #/onboarding: that page sends a connected app straight back to the board. With several hubs there is one
// row per hub, each under its name and with its own state: one offline never hides another. While any of the hub's
// machines is down the row says how many ("1 down"), which opens Machines, as the popover's Machines line always does:
// the sidebar has no Machines entry. For a member, who can't open Machines, both are plain text. A cloud machine
// asleep is at rest, not down. Any update says one word at the row's end ("Updating…", "Updated", "Put back", or
// "Update" with one to take), and what goes with it leads the popover (updates/quiet.ts). While the hub restarts it
// keeps its name, and its dot opens to a ring until it answers.
import { useState } from "react";
import type { HubState } from "../../../shared/hub";
import { versionLabel } from "../../../shared/updates";
import { useData, useDataLayer, useHub, useSeveralHubs } from "../../src/data/react";
import { selectMachines } from "../../src/data/selectors";
import { Button, Dot, Popover, PopoverContent, PopoverTrigger, Text, Tooltip } from "../../ui";
import { useSettledAdministers } from "../admin/role";
import { Prose } from "../onboarding/Prose";
import { ForgetHubDialog, OPTIONS, openOption } from "../settings";
import { connLine, type ConnTone } from "./model";
import { navigate } from "./navigation";
import { useOfflineAsOf } from "./offline";
import { UpdateNote, UpdateWord, useQuiet } from "../updates";
import h from "./hubStatus.module.css";

const TONE: Record<ConnTone, string> = { success: "var(--success)", warning: "var(--warning)", danger: "var(--danger)", quiet: "var(--faint)", restarting: "var(--faint)" };

const HUB_OPTION = OPTIONS.find((o) => o.key === "hubs.hub");

/** A dot with a faint ring of its own color; while the hub restarts, the dot opened to a ring. */
const SoftDot = ({ tone }: { tone: ConnTone }) => (
  <span className={h.dot} style={{ color: TONE[tone] }}>
    {tone === "restarting" ? <span className={h.ring} aria-hidden /> : <Dot color={TONE[tone]} />}
  </span>
);

export function HubStatus({ hub }: { hub: HubState }) {
  const asOf = useOfflineAsOf();
  const conn = connLine(hub, window.fleetd.fixture !== null, asOf);
  const layer = useDataLayer();
  const self = useHub();
  const several = useSeveralHubs();
  const pair = () => {
    window.location.hash = several ? `#/onboarding?another&at=${self.id}` : "#/onboarding";
  };
  // With several hubs a row is named for its hub, and says its state beside the name unless it is connected.
  const label = several ? self.label : conn.label;
  // The state's own word even under a fixture, whose chip otherwise only says it is sample data.
  const aside = several && hub.phase !== "live" ? connLine(hub, false, asOf).label : null;
  const machines = useData(selectMachines);
  const own = machines?.filter((m) => m.machine.cloud !== true);
  const cloud = (machines?.length ?? 0) - (own?.length ?? 0);
  const down = own?.filter((m) => m.machine.status !== "online").length ?? 0;
  const online = `${String((own?.length ?? 0) - down)} of ${String(own?.length ?? 0)} online${cloud === 0 ? "" : ` · ${String(cloud)} cloud`}`;
  const admin = useSettledAdministers();
  const [open, setOpen] = useState(false);
  // Controlled, so its content never changes (an empty one would drop the Tooltip and remount the chip): it just
  // stays shut while the popover is open.
  const [tip, setTip] = useState(false);
  const [forget, setForget] = useState(false);
  const quiet = useQuiet(hub);
  const live = hub.phase === "live" ? hub : null;
  const paired = hub.phase !== "unpaired" && window.fleetd.fixture === null;
  const said = several ? `${self.label}, ${conn.status.toLowerCase()}` : conn.label === conn.status ? conn.label : `${conn.label}, ${conn.status.toLowerCase()}`;
  const name = quiet === null || quiet.kind === "restarting" ? said : `${said}, ${quiet.word.text.toLowerCase()}`;

  return (
    <div className={h.row}>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip content={conn.hub ?? conn.detail ?? conn.status} side="right" open={tip && !open} onOpenChange={setTip}>
          <PopoverTrigger asChild>
            <button type="button" className={h.chip} data-hub-status={hub.phase} data-tone={conn.tone} aria-label={`Hub: ${name}`}>
              <SoftDot tone={conn.tone} />
              <span className={h.label}>{label}</span>
              {aside === null || conn.tone === "restarting" ? null : <span className={h.aside}>{aside}</span>}
              {quiet === null ? null : <UpdateWord quiet={quiet} />}
            </button>
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent side="top" align="start" aria-label="Hub">
          <div className={h.card}>
            {quiet?.note == null ? null : (
              <UpdateNote
                note={quiet.note}
                onDetails={() => {
                  setOpen(false);
                  navigate({ id: "settings", tab: "hub.updates", at: self.id });
                }}
              />
            )}
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
                  <dd>
                    {admin ? (
                      <button
                        type="button"
                        className={h.factLink}
                        data-opens="machines"
                        onClick={() => {
                          setOpen(false);
                          navigate({ id: "settings", tab: "hub.machines", at: self.id });
                        }}
                      >
                        {online}
                      </button>
                    ) : (
                      online
                    )}
                  </dd>
                </>
              )}
              {live === null ? null : (
                <>
                  <dt>Protocol</dt>
                  <dd title={live.version} data-version>{live.version === undefined ? `v${String(live.protocol)}` : `v${String(live.protocol)} · fleetd ${versionLabel(live.version)}`}</dd>
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
                      if (HUB_OPTION !== undefined) openOption(several ? { ...HUB_OPTION, key: `hubs.${self.id}` } : HUB_OPTION);
                    }}
                  >
                    Settings › Hubs
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
      {down > 0 && !admin ? (
        <span className={h.down} data-down>
          {`${String(down)} down`}
        </span>
      ) : down > 0 ? (
        <button
          type="button"
          className={h.down}
          data-opens="machines"
          aria-label={`${String(down)} ${down === 1 ? "machine" : "machines"} down: open Machines`}
          onClick={() => navigate({ id: "settings", tab: "hub.machines", at: self.id })}
        >
          {`${String(down)} down`}
        </button>
      ) : null}
      <ForgetHubDialog open={forget} onOpenChange={setForget} only={!several} />
    </div>
  );
}
