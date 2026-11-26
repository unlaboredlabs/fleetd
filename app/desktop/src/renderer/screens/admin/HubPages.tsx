// Settings' Hub group (#/settings/hub/<page>, D211): the hub's owners' and admins' pages, in the Settings window and
// shown to nobody else; the hub refuses anyone else's change too. People (roles, Invite someone and the invites open);
// Machines (the machines, Add machine at the title's end or in the empty list, each machine's
// page with Repair while it isn't well, what is wrong with it, its role, its screens, its max agents and Remove; then updates, Updates.tsx:
// where the hub and each machine stand, Update now and Update automatically; and recordings); Providers (what agents
// run on, Anthropic and Google, each with how it is connected, its setup and the task profiles that run on it:
// settings/AgentProviders.tsx); Every project, laid out as a project's own pages are: Agents (the default profile, what
// leads run on, and the skills), Instructions (and the hub-wide
// built-in prompts from its foot) and Vault (the vault key, settings/Vault.tsx), each reaching every project on the hub; and Setup (SetupPage.tsx): the hub's accounts (its
// Claude API key and its GitHub App among them, Hub accounts once) and its other setup steps still left, always listed,
// with how many required ones are left. With several hubs the group manages one hub at a time, named above every
// page, and switches between the hubs this person administers: nothing here acts on a hub the page doesn't name.
import { useEffect, useState, type ReactNode } from "react";
import { Text } from "../../ui";
import type { HubView } from "../../src/data/hubs";
import { HubScope, useHub, useHubs, useSeveralHubs } from "../../src/data/react";
import { HUB_COLOR } from "../shell/hubColor";
import { AddMachine, type View } from "../addMachine";
import { ProvidersGroup, WhatRunsWhere } from "../settings/Places";
import { ProvidersPage } from "../settings/AgentProviders";
import { BuiltInPrompts, HubInstructions } from "../settings/Instructions";
import { EveryProjectFrame, Part } from "../settings/Frames";
import { PageHead, SettingsSection } from "../settings/parts";
import { revealNext, useReveal } from "../settings/search";
import { hostedReveal, RUNNER_ID } from "../../../shared/providers";
import { ProfilePicks } from "../settings/Profiles";
import { Prompts } from "../settings/Prompts";
import { isEveryProject, replaceHash, type SettingsRoute } from "../settings/route";
import { HubSkills } from "../settings/Skills";
import { HubVault } from "../settings/Vault";
import { navigate } from "../shell/navigation";
import { parseHash, toHash, type HubTab } from "../shell/routes";
import { AuditLog } from "./AuditLog";
import { Billing } from "./Billing";
import { useBillingShown } from "./billingQuery";
import { AddMachineButton, MachineList, useTeamMachines } from "./MachineList";
import { MachinePage } from "./MachinePage";
import { ProvidedComputers } from "./Provided";
import { People } from "./People";
import { SetupPage } from "./SetupPage";
import { Updates } from "./Updates";
import { useAdministers, useHubRole, type HubRoleView } from "./role";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

/** A hub's colour as a small mark before its name; none without a colour. */
export const HubMark = ({ hub }: { hub: HubView }) =>
  hub.color === undefined ? null : <span className={a.hubMark} style={{ background: HUB_COLOR[hub.color] }} aria-hidden />;

/**
 * A hub to manage: listed when this person administers it there (and the one managed now, whatever its answer); on
 * Billing, only a hub that has it, so no choice leads to a page that isn't there.
 */
function HubChoice({ hub, tab, current, onPick }: { hub: HubView; tab: HubTab; current: boolean; onPick: () => void }) {
  const administers = useAdministers();
  const billing = useBillingShown(tab === "hub.billing" && !current);
  if (!current && (!administers || (tab === "hub.billing" && !billing))) return null;
  return (
    <button type="button" className={a.hubChoice} aria-current={current ? "page" : undefined} data-admin-hub={hub.id} onClick={onPick}>
      <HubMark hub={hub} />
      {hub.label}
    </button>
  );
}

/** The Hub page the route names, for an owner or admin; anyone else who follows a link here is told why not. */
export function HubPage({ tab, route }: { tab: HubTab; route: SettingsRoute }) {
  const role = useHubRole();
  // A fresh snapshot (a machine that just joined brings one) drops hub_info's answer until it is read again: the page
  // stays as the last answer had it meanwhile, so what is open on it (a machine's line, waiting) isn't lost.
  const [settled, setSettled] = useState<HubRoleView>();
  if (!role.pending && (settled?.administers !== role.administers || settled.me !== role.me || settled.offline !== role.offline)) setSettled(role);
  const view = role.pending && settled !== undefined ? settled : role;
  return (
    <>
      <Managing tab={tab} />
      {view.administers && tab !== "hub.prompts" && isEveryProject(tab) ? <EveryProjectFrame tab={tab}>{page(tab, route, view)}</EveryProjectFrame> : page(tab, route, view)}
    </>
  );
}

/**
 * With several hubs, the one every page here acts on, by its name and colour, above the page, and the others this
 * person administers beside it to switch to, keeping the page.
 */
function Managing({ tab }: { tab: HubTab }) {
  const several = useSeveralHubs();
  const hub = useHub();
  const hubs = useHubs();
  if (!several) return null;
  return (
    <div className={a.managing}>
      <div className={a.managingLine} role="note" aria-label={`Managing ${hub.label}`} data-managing={hub.id}>
        <Text size="sm" tone="quiet">
          Managing
        </Text>
        <div className={a.hubChoices} role="group" aria-label="Workspace to manage">
          {hubs.map((h) => (
            <HubScope key={h.id} hub={h}>
              <HubChoice hub={h} tab={tab} current={h.id === hub.id} onPick={() => navigate({ id: "settings", tab, at: h.id })} />
            </HubScope>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * `#/settings/hub/machines/hosted`: the hosted sandboxes are a provider's, so the link lands on Machines at the
 * provider's row (its state and limit) and the address becomes Machines', never a machine page with controls that do
 * nothing for them.
 */
function ToProviders() {
  useEffect(() => {
    revealNext(hostedReveal());
    const here = parseHash(window.location.hash);
    if (here.id !== "settings") return;
    // Its hub (`at`) stays.
    const { machine: _hosted, ...machines } = here;
    replaceHash(toHash(machines));
  }, []);
  return <Machines />;
}

function page(tab: HubTab, route: SettingsRoute, { administers, me, pending, offline }: HubRoleView): ReactNode {
  if (!administers) {
    // A member who follows a link here sees why, and nothing else; with no hub, there is no one to ask yet.
    const [screen, text] = offline
      ? ["settings.hub.offline", "Connect to a workspace to see and change this."]
      : pending
        ? ["settings.hub.loading", "Loading…"]
        : ["settings.hub.denied", "This page is for the workspace's owners and admins. Ask one of them for what you need."];
    return (
      <div className={s.scroll} data-screen={screen}>
        <div className={s.column}>
          <PageHead title="Workspace" />
          <Text tone="quiet">{text}</Text>
        </div>
      </div>
    );
  }
  switch (tab) {
    case "hub.people":
      return <People me={me} />;
    // The task profiles are a part of Providers, under each provider (settings/route.ts).
    case "hub.providers":
    case "hub.profiles":
      return <ProvidersPage me={me} />;
    case "hub.billing":
      return <Billing />;
    case "hub.audit":
      return <AuditLog />;
    case "hub.machines":
      return route.machine === undefined ? <Machines /> : route.machine === RUNNER_ID ? <ToProviders /> : <MachinePage machineId={route.machine} />;
    // Updates is a part of Machines, and Tools & skills of Every project › Agents (settings/route.ts).
    case "hub.updates":
      return <Machines />;
    case "hub.agents":
    case "hub.tools":
      return <EveryAgents />;
    case "hub.instructions":
      return <EveryInstructions />;
    case "hub.prompts":
      return <Prompts where="hub" route={{ tab: "hub.prompts", prompt: route.prompt, for: null }} />;
    case "hub.vault":
      return <HubVault />;
    // Hub accounts is a part of Setup (settings/route.ts).
    case "hub.accounts":
    case "hub.setup":
      return <SetupPage me={me} />;
  }
}

/**
 * One page, in the order a person comes to it (D550): the hub's machines and how each is (a row each, its state a dot,
 * opening its own page with everything about it; Add machine at the title's end adds one, its steps opening above the
 * list, and with none yet the empty list holds the button instead); the providers
 * the team connects with its own keys, one list, each with what it can run (Tailscale is Connections'); what runs where, a row per kind of work
 * with the same choice; on a fleetd cloud team, fleetd's computers (Provided.tsx); then updates, the one status of them and the Update automatically switch (a page of its own
 * once: a link to it lands here).
 */
function Machines() {
  const [open, setOpen] = useState<{ view: View; at: number }>();
  const add = () => setOpen({ view: { kind: "choose" }, at: Date.now() });
  // With none yet, the empty list holds the one Add machine.
  const none = useTeamMachines()?.length === 0;
  // A search for "add machine" lands on the button.
  const addRef = useReveal<HTMLSpanElement>("hub.add-machine");
  return (
    <div className={s.scroll} data-screen="settings.hub.machines">
      <div className={s.column}>
        <PageHead
          title="Machines"
          aside={
            none ? undefined : (
              <span ref={addRef}>
                <AddMachineButton onClick={add} />
              </span>
            )
          }
        />
        <AddMachine open={open} closed={open === undefined} onClose={() => setOpen(undefined)} />
        <MachineList onAdd={add} />
        <ProvidersGroup />
        <WhatRunsWhere />
        <ProvidedComputers />
        <Updates />
      </div>
    </div>
  );
}

/**
 * Every project › Agents: what every project's agents run on and get. The default profile and the one leads run on,
 * picked from the task profiles Providers lists under each provider (each project picks which it allows on its own
 * Agents page), then the skills, which come before a project's own (Tools & skills, a page of its own once). MCP
 * servers are Connections'.
 */
function EveryAgents() {
  return (
    <div className={s.scroll} data-screen="settings.hub.agents">
      <div className={s.column}>
        <PageHead title="Agents" />
        <ProfilePicks />
        <Part reveal="hub.tools" screen="settings.hub.tools">
          <HubSkills />
        </Part>
      </div>
    </div>
  );
}

/** Every project › Instructions: the instructions every project's agents get. */
function EveryInstructions() {
  return (
    <div className={s.scroll} data-screen="settings.hub.instructions">
      <div className={s.column}>
        <PageHead title="Instructions" />
        <SettingsSection title="Instructions" reveal="hub.instructions">
          <HubInstructions />
        </SettingsSection>
        <BuiltInPrompts project={null} />
      </div>
    </div>
  );
}
