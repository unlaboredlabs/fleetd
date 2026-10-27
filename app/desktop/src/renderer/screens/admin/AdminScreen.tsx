// Administration (#/admin/<section>): the hub's owners' and admins' page, apart from Settings so nobody else ever sees
// an admin control. People, Invites, Machines (Add machine, the machines with Repair and Remove, and each one's page
// with its checklist), Claude (the hub's API key and who may use it), Hub settings (everything hub-wide that used to sit in
// Settings: the fleet and machine caps, machine roles, task profiles and memory caps), Skills (the hub-wide ones), Google
// (the hub's OAuth client for Navis, google/AdminGoogle.tsx) and Setup. The shell shows AdminSidebar in the sidebar's
// place while it is open, as it does Settings'. With several hubs (docs/design/hubs.md) it manages one hub at a time,
// named above every page, and its sidebar switches between the hubs this person administers: nothing here acts on a
// hub the page doesn't name.
import { ArrowLeft, Bot, KeyRound, ListChecks, Server, SlidersHorizontal, Sparkles, UserPlus, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button, Separator, Sidebar, SidebarItem, SidebarSection, Text, Truncate } from "../../ui";
import type { HubView } from "../../src/data/hubs";
import { HubScope, useData, useHub, useHubs, useSeveralHubs } from "../../src/data/react";
import { HUB_COLOR } from "../shell/hubColor";
import { AddMachine, type View } from "../addMachine";
import { HubCaps, TaskProfiles } from "../settings/Agents";
import { MachineRoles } from "../settings/MachineRoles";
import { HubMemoryCaps } from "../settings/MemoryCaps";
import { PageHead } from "../settings/parts";
import { HubSkills } from "../settings/Skills";
import { AdminGoogle } from "../google/AdminGoogle";
import { navigate, useRoute } from "../shell/navigation";
import { toHash, type AdminSection } from "../shell/routes";
import { ClaudeAdmin } from "./Claude";
import { Invites } from "./Invites";
import { MachineList } from "./MachineList";
import { MachinePage } from "./MachinePage";
import { People } from "./People";
import { useAdministers, useHubRole, type HubRoleView } from "./role";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

const SECTIONS: ReadonlyArray<{ section: AdminSection; label: string; icon: ReactNode }> = [
  { section: "people", label: "People", icon: <Users /> },
  { section: "invites", label: "Invites", icon: <UserPlus /> },
  { section: "machines", label: "Machines", icon: <Server /> },
  { section: "claude", label: "Claude", icon: <Bot /> },
  { section: "hub", label: "Hub settings", icon: <SlidersHorizontal /> },
  { section: "skills", label: "Skills", icon: <Sparkles /> },
  { section: "google", label: "Google", icon: <KeyRound /> },
  { section: "setup", label: "Setup", icon: <ListChecks /> },
];

const useSection = (): AdminSection => {
  const route = useRoute();
  return route.id === "admin" ? route.section : "people";
};

/** The machine whose page is open, on Machines. */
const useMachine = (): string | undefined => {
  const route = useRoute();
  return route.id === "admin" ? route.machine : undefined;
};

/** A section of Administration on hub `at`, named in the route: never the hub some other screen had open. */
const go = (section: AdminSection, at: string) => navigate({ id: "admin", section, at });

/** A hub's colour as a small mark before its name; none without a colour. */
const Mark = ({ hub }: { hub: HubView }) =>
  hub.color === undefined ? null : <span className={a.hubMark} style={{ background: HUB_COLOR[hub.color] }} aria-hidden />;

export function AdminSidebar({ onBack }: { onBack: () => void }) {
  const section = useSection();
  const { id } = useHub();
  const hubs = useHubs();
  return (
    <Sidebar aria-label="Administration">
      <SidebarSection>
        <SidebarItem label="Back" icon={<ArrowLeft />} onClick={onBack} />
      </SidebarSection>
      <SidebarSection title="Administration">
        {SECTIONS.map((x) => (
          <SidebarItem key={x.section} label={x.label} icon={x.icon} current={section === x.section} onClick={() => go(x.section, id)} />
        ))}
      </SidebarSection>
      {hubs.length > 1 ? (
        <SidebarSection title="Hub" label="Hub to manage">
          {hubs.map((hub) => (
            <HubScope key={hub.id} hub={hub}>
              <HubChoice hub={hub} current={hub.id === id} onPick={() => go(section, hub.id)} />
            </HubScope>
          ))}
        </SidebarSection>
      ) : null}
    </Sidebar>
  );
}

/** A hub to manage: listed when this person administers it there (and the one managed now, whatever its answer). */
function HubChoice({ hub, current, onPick }: { hub: HubView; current: boolean; onPick: () => void }) {
  const administers = useAdministers();
  if (!administers && !current) return null;
  return <SidebarItem label={hub.label} icon={<Mark hub={hub} />} current={current} data-admin-hub={hub.id} onClick={onPick} />;
}

export function AdminScreen() {
  const section = useSection();
  const machine = useMachine();
  const role = useHubRole();
  // A fresh snapshot (a machine that just joined brings one) drops hub_info's answer until it is read again: the page
  // stays as the last answer had it meanwhile, so what is open on it (a machine's line, waiting) isn't lost.
  const [settled, setSettled] = useState<HubRoleView>();
  if (!role.pending && (settled?.administers !== role.administers || settled.me !== role.me || settled.offline !== role.offline)) setSettled(role);
  return (
    <div className={s.frame}>
      <Managing />
      {page(section, machine, role.pending && settled !== undefined ? settled : role)}
    </div>
  );
}

/** With several hubs, the one every page here acts on, by name and address, above the page. */
function Managing() {
  const several = useSeveralHubs();
  const hub = useHub();
  const state = useData((st) => st.hub);
  if (!several) return null;
  return (
    <div className={a.managing} role="note" aria-label={`Managing ${hub.label}`} data-managing={hub.id}>
      <Text size="sm" tone="quiet">
        Managing
      </Text>
      <Mark hub={hub} />
      <Text size="sm" strong>
        {hub.label}
      </Text>
      {state.phase === "unpaired" ? null : (
        <Truncate size="xs" tone="quiet" mono>
          {state.hub}
        </Truncate>
      )}
    </div>
  );
}

function page(section: AdminSection, machine: string | undefined, { administers, me, pending, offline }: HubRoleView): ReactNode {
  if (!administers) {
    // A member who follows a link here sees why, and nothing else; with no hub, there is no one to ask yet.
    const [screen, text] = offline
      ? ["admin.offline", "Connect to a hub to see and change this."]
      : pending
        ? ["admin.loading", "Loading…"]
        : ["admin.denied", "Administration is for the hub's owners and admins. Ask one of them for what you need."];
    return (
      <div className={s.scroll} data-screen={screen}>
        <div className={s.column}>
          <PageHead title="Administration" />
          <Text tone="quiet">{text}</Text>
        </div>
      </div>
    );
  }
  switch (section) {
    case "people":
      return <People me={me} />;
    case "invites":
      return <Invites me={me} />;
    case "machines":
      return machine === undefined ? <Machines /> : <MachinePage machineId={machine} />;
    case "claude":
      return <ClaudeAdmin me={me} />;
    case "hub":
      return <HubSettings />;
    case "skills":
      return <HubSkills />;
    case "google":
      return <AdminGoogle />;
    case "setup":
      return <Setup />;
  }
}

/**
 * Adding machines to the hub (this computer, one the hub reaches over SSH, or any other), then its machines, each with
 * Repair (which opens in Add machine) and Remove, and a page of its own with its checklist.
 */
function Machines() {
  const [open, setOpen] = useState<{ view: View; at: number }>();
  return (
    <div className={s.scroll} data-screen="admin.machines">
      <div className={s.column}>
        <PageHead title="Machines">The computers that run this hub's agents. Machine roles are in Hub settings.</PageHead>
        <AddMachine open={open} />
        <Separator />
        <MachineList
          onRepair={(r) => {
            setOpen({ view: r, at: Date.now() });
            document.querySelector("section[aria-label='Add machine']")?.scrollIntoView({ block: "nearest" });
          }}
        />
      </div>
    </div>
  );
}

/** Everything hub-wide: it reaches every project and machine, so only an owner or admin changes it. */
function HubSettings() {
  return (
    <div className={s.scroll} data-screen="admin.hub">
      <div className={s.column}>
        <PageHead title="Hub settings">What reaches every project and machine on this hub.</PageHead>
        <HubCaps />
        <Separator />
        <TaskProfiles />
        <Separator />
        <MachineRoles />
        <Separator />
        <HubMemoryCaps />
      </div>
    </div>
  );
}

/**
 * Where the hub's one guided setup goes once it is built (docs/design: the first-run setup): the same steps as
 * `fleetd init`. Until then, the setup checks on Machines.
 */
function Setup() {
  return (
    <div className={s.scroll} data-screen="admin.setup">
      <div className={s.column}>
        <PageHead title="Setup">The hub's guided setup comes here: the same steps as fleetd init, each with the values to paste and a Test button.</PageHead>
        <Text size="sm" tone="quiet">
          Until then, the setup checks on Machines say what is missing and fix what they can.
        </Text>
        <span>
          <Button onClick={() => (window.location.hash = toHash({ id: "machines" }))}>Open the setup checks</Button>
        </span>
      </div>
    </div>
  );
}
