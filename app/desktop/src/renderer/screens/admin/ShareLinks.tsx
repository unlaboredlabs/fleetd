// Settings › Workspace › Share links (#/settings/hub/share): the switch that lets agents and people share a dev
// server's port as a link only the workspace's signed-in members open, where links live (a self-hosted workspace's own
// wildcard name; the cloud's is its own), every open link with Open, Renew and Stop, and sharing a port by hand. Renew
// here is a person's, so on fleetd's computers it also keeps the link's computer running to the link's new end.
import { Link2, MonitorPlay } from "lucide-react";
import { useState } from "react";
import type { ShareLink } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useData, useHub, useToolQuery } from "../../src/data/react";
import { Button, Input, Select, Text, toast } from "../../ui";
import { untilText, useMachineName, useOpenPreview } from "../chat/blocks/PreviewCard";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { EmptyState, PageHead, SettingsList, SettingsListRow, SettingsRow, SettingsSection, SwitchRow } from "../settings/parts";
import { selectMachines } from "../../src/data/selectors";
import { keptRunning } from "../../../shared/providers";
import s from "../settings/settings.module.css";

const noInput = {};
const RENEW_MINUTES = 120;

/** Who made a link, in words: a person by name, an agent as one. */
export const madeBy = (l: ShareLink): string => (l.createdBy.kind === "agent" ? "Made by an agent" : `Made by ${l.createdBy.name}`);

export function ShareLinks() {
  const live = useLive();
  const hub = useHub();
  const call = useHubCall();
  const refetch = useRefetch();
  const list = useToolQuery("share_links_list", noInput, { enabled: live });
  const lacks = list.error instanceof CallError && lacksTool(list.error.error);
  const cloud = hub.cloud === true || hub.codePaired === true;
  const act = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run();
      refetch(["share_links_list"]);
    } catch (e) {
      toast({ tone: "danger", title: what, description: errorText(e) });
    }
  };
  const data = list.data;
  return (
    <div className={s.scroll} data-screen="settings.hub.share">
      <div className={s.column}>
        <PageHead title="Share links" />
        {lacks ? (
          <Text tone="quiet">This workspace has no share links yet: update fleetd on it.</Text>
        ) : list.isLoadingError ? (
          <Text tone="danger">{errorText(list.error)}</Text>
        ) : data === undefined ? (
          <Text tone="quiet">Loading…</Text>
        ) : (
          <>
            <SettingsSection>
              <SwitchRow
                title="Share links"
                hint="Agents and people turn a dev server's port into a link, to open the running app in a browser or on a phone. Only the workspace's signed-in members open one, and each ends after a few hours."
                checked={data.enabled}
                disabled={!live}
                onCheckedChange={(on) => void act(on ? "Share links didn’t turn on" : "Share links didn’t turn off", () => call("share_links_settings_set", { enabled: on }))}
              />
              {cloud ? null : <Address current={data.previewUrl} disabled={!live} save={(url) => act("The address wasn’t saved", () => call("share_links_settings_set", { previewUrl: url }))} />}
            </SettingsSection>
            <SettingsSection title="Open links" data={{ "data-share-links": String(data.links.length) }}>
              {data.links.length === 0 ? (
                <EmptyState icon={<Link2 />} title="No open links. Agents make them as they start dev servers, or share a port below." />
              ) : (
                <LinkList links={data.links} disabled={!live} act={act} />
              )}
            </SettingsSection>
            {data.enabled && data.previewUrl !== undefined ? <SharePort disabled={!live} act={act} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

function Address({ current, disabled, save }: { current: string | undefined; disabled: boolean; save: (url: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const value = draft ?? current ?? "";
  return (
    <SettingsRow
      title="Preview address"
      hint="A name of its own whose every subdomain reaches this workspace, like https://preview.example.com with a wildcard DNS record and certificate. Never the workspace's own address."
      line={current === undefined ? "None yet: links can't be made until one is set." : undefined}
      lineTone={current === undefined ? "warning" : undefined}
      control={
        <span style={{ display: "flex", gap: "var(--space-2)" }}>
          <Input aria-label="Preview address" mono placeholder="https://preview.example.com" value={value} style={{ width: "34ch" }} disabled={disabled} onChange={(e) => setDraft(e.target.value)} />
          <Button variant="secondary" disabled={disabled || draft === undefined || draft === (current ?? "")} onClick={() => void save(value).then(() => setDraft(undefined))}>
            Save
          </Button>
        </span>
      }
    />
  );
}

function LinkList({ links, disabled, act }: { links: readonly ShareLink[]; disabled: boolean; act: (what: string, run: () => Promise<unknown>) => Promise<void> }) {
  const call = useHubCall();
  const open = useOpenPreview();
  const machineName = useMachineName();
  return (
    <SettingsList label="Open links">
      {links.map((l) => (
        <SettingsListRow
          key={l.name}
          label={l.label ?? `Port ${l.port}`}
          icon={<MonitorPlay />}
          name={l.label ?? `Port ${l.port}`}
          meta={l.label === undefined ? `on ${machineName(l.machineId)}` : `port ${l.port} on ${machineName(l.machineId)}`}
          data={{ "data-share-link": l.name }}
          controls={
            <>
              <Button variant="secondary" disabled={disabled} onClick={() => void open(l.name)}>
                Open
              </Button>
              <Button variant="ghost" disabled={disabled} onClick={() => void act("The link wasn’t renewed", () => call("share_link_renew", { name: l.name, minutes: RENEW_MINUTES }))}>
                Renew
              </Button>
              <Button variant="ghost" disabled={disabled} onClick={() => void act("The link wasn’t stopped", () => call("share_link_revoke", { name: l.name }))}>
                Stop
              </Button>
            </>
          }
        >
          <Text size="sm" tone="quiet">
            {madeBy(l)} · open {untilText(l.expiresAt)}
          </Text>
          {keptRunning(l.machineId) !== undefined ? (
            <Text as="div" size="sm" tone="quiet" data-kept="">
              {keptRunning(l.machineId)}
            </Text>
          ) : null}
        </SettingsListRow>
      ))}
    </SettingsList>
  );
}

function SharePort({ disabled, act }: { disabled: boolean; act: (what: string, run: () => Promise<unknown>) => Promise<void> }) {
  const call = useHubCall();
  const machines = useData(selectMachines) ?? [];
  const [machine, setMachine] = useState<string | undefined>(undefined);
  const [port, setPort] = useState("");
  const chosen = machine ?? machines[0]?.machine.machineId;
  const n = Number(port);
  const ok = chosen !== undefined && Number.isInteger(n) && n >= 1 && n <= 65535;
  return (
    <SettingsSection title="Share a port" hint="A dev server already running on one of the workspace's machines: its port becomes a link for two hours.">
      <SettingsRow
        title="Machine and port"
        control={
          <span style={{ display: "flex", gap: "var(--space-2)" }}>
            <Select aria-label="Machine" value={chosen} onValueChange={setMachine} options={machines.map((m) => ({ value: m.machine.machineId, label: m.machine.name }))} />
            <Input aria-label="Port" inputMode="numeric" placeholder="5173" value={port} style={{ width: "10ch" }} disabled={disabled} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} />
            <Button
              variant="secondary"
              disabled={disabled || !ok}
              onClick={() => {
                if (chosen !== undefined) void act("The port wasn’t shared", () => call("share_port", { machineId: chosen, port: n }).then(() => setPort("")));
              }}
            >
              Share
            </Button>
          </span>
        }
      />
    </SettingsSection>
  );
}
