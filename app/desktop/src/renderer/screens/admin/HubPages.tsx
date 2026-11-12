// Settings' Hub group (#/settings/hub/<page>, D211): the hub's owners' and admins' pages, in the Settings window and
// shown to nobody else; the hub refuses anyone else's change too. People (roles, Invite someone and the invites open,
// and every hub link); Machines (the machines, Add machine behind the page's plus, each machine's page with Repair
// while it isn't well, what is wrong with it, its role, its screens, its max agents and Remove; then updates, Updates.tsx:
// where the hub and each machine stand, Update now and Update automatically; and recordings); Every project, laid out
// as a project's own pages are: Agents (the profiles, the MCP servers and the skills), Instructions (and the hub-wide
// built-in prompts from its foot) and Vault (the vault key, settings/Vault.tsx), each reaching every project on the hub; and Setup (SetupPage.tsx): the hub's accounts (its
// Claude API key and its GitHub App among them, Hub accounts once) and its other setup steps still left, always listed,
// with how many required ones are left. With several hubs the group manages one hub at a time, named above every
// page, and switches between the hubs this person administers: nothing here acts on a hub the page doesn't name.
import { useState, type ReactNode } from "react";
import { Text } from "../../ui";
import type { HubView } from "../../src/data/hubs";
import { HubScope, useHub, useHubs, useSeveralHubs } from "../../src/data/react";
import { HUB_COLOR } from "../shell/hubColor";
import { AddMachine, type View } from "../addMachine";
import { Recordings } from "../settings/Screens";
import { BuiltInPrompts, HubInstructions } from "../settings/Instructions";
import { HubMcpServers } from "../settings/McpServers";
import { EveryProjectFrame, Part } from "../settings/Frames";
import { AddButton, PageHead, SettingsSection } from "../settings/parts";
import { useReveal } from "../settings/search";
import { ProfilesEditor } from "../settings/Profiles";
import { Prompts } from "../settings/Prompts";
import { isEveryProject, type SettingsRoute } from "../settings/route";
import { HubSkills } from "../settings/Skills";
import { HubVault } from "../settings/Vault";
import { navigate } from "../shell/navigation";
import type { HubTab } from "../shell/routes";
import { MachineList } from "./MachineList";
import { MachinePage } from "./MachinePage";
import { People } from "./People";
import { SetupPage } from "./SetupPage";
import { Updates } from "./Updates";
import { useAdministers, useHubRole, type HubRoleView } from "./role";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

/** A hub's colour as a small mark before its name; none without a colour. */
export const HubMark = ({ hub }: { hub: HubView }) =>
  hub.color === undefined ? null : <span className={a.hubMark} style={{ background: HUB_COLOR[hub.color] }} aria-hidden />;

/** A hub to manage: listed when this person administers it there (and the one managed now, whatever its answer). */
function HubChoice({ hub, current, onPick }: { hub: HubView; current: boolean; onPick: () => void }) {
  const administers = useAdministers();
  if (!administers && !current) return null;
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
    <div className={a.managing} role="note" aria-label={`Managing ${hub.label}`} data-managing={hub.id}>
      <Text size="sm" tone="quiet">
        Managing
      </Text>
      <div className={a.hubChoices} role="group" aria-label="Hub to manage">
        {hubs.map((h) => (
          <HubScope key={h.id} hub={h}>
            <HubChoice hub={h} current={h.id === hub.id} onPick={() => navigate({ id: "settings", tab, at: h.id })} />
          </HubScope>
        ))}
      </div>
    </div>
  );
}

function page(tab: HubTab, route: SettingsRoute, { administers, me, pending, offline }: HubRoleView): ReactNode {
  if (!administers) {
    // A member who follows a link here sees why, and nothing else; with no hub, there is no one to ask yet.
    const [screen, text] = offline
      ? ["settings.hub.offline", "Connect to a hub to see and change this."]
      : pending
        ? ["settings.hub.loading", "Loading…"]
        : ["settings.hub.denied", "This page is for the hub's owners and admins. Ask one of them for what you need."];
    return (
      <div className={s.scroll} data-screen={screen}>
        <div className={s.column}>
          <PageHead title="Hub" />
          <Text tone="quiet">{text}</Text>
        </div>
      </div>
    );
  }
  switch (tab) {
    case "hub.people":
      return <People me={me} />;
    case "hub.machines":
      return route.machine === undefined ? <Machines /> : <MachinePage machineId={route.machine} />;
    // Updates is a part of Machines, and Tools & skills of Every project › Agents (settings/route.ts).
    case "hub.updates":
      return <Machines />;
    case "hub.profiles":
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
 * The hub's machines, each a row that opens its own page with everything about it; the page's plus adds one (this
 * computer, one the hub reaches over SSH, or any other), its steps opening above the list. Then updates, the one
 * status of them and the Update automatically switch (a page of its own once: a link to it lands here), and how long
 * recordings are kept.
 */
function Machines() {
  const [open, setOpen] = useState<{ view: View; at: number }>();
  // A search for "add machine" lands on the plus.
  const addRef = useReveal<HTMLSpanElement>("hub.add-machine");
  return (
    <div className={s.scroll} data-screen="settings.hub.machines">
      <div className={s.column}>
        <PageHead
          title="Machines"
          aside={
            <span ref={addRef}>
              <AddButton label="Add machine" onClick={() => setOpen({ view: { kind: "choose" }, at: Date.now() })} />
            </span>
          }
        />
        <AddMachine open={open} closed={open === undefined} onClose={() => setOpen(undefined)} />
        <MachineList />
        <Updates />
        <SettingsSection title="Recordings" reveal="hub.recordings">
          <Recordings />
        </SettingsSection>
      </div>
    </div>
  );
}

/**
 * Every project › Agents: what every project's agents run on and get. The task profiles (each a model, an effort, fast
 * mode and a note, and the hub's default; each project picks which it allows on its own Agents page), then the MCP
 * servers and the skills, which come before a project's own (Tools & skills, a page of its own once).
 */
function EveryAgents() {
  return (
    <div className={s.scroll} data-screen="settings.hub.profiles">
      <div className={s.column}>
        <PageHead title="Agents" />
        <ProfilesEditor />
        <Part reveal="hub.tools" screen="settings.hub.tools">
          <SettingsSection title="MCP servers" reveal="hub.mcp">
            <HubMcpServers />
          </SettingsSection>
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
