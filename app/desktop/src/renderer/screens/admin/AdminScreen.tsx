// Administration (#/admin/<section>): the hub's owners' and admins' page, apart from Settings so nobody else ever sees
// an admin control. People, Invites, Machines (Add machine), Hub settings (everything hub-wide that used to sit in
// Settings: the fleet and machine caps, machine roles, task profiles and memory caps) and Setup. The shell shows AdminSidebar in the sidebar's
// place while it is open, as it does Settings'.
import { ArrowLeft, ListChecks, Server, SlidersHorizontal, UserPlus, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Separator, Sidebar, SidebarItem, SidebarSection, Text } from "../../ui";
import { AddMachine } from "../addMachine";
import { HubCaps, TaskProfiles } from "../settings/Agents";
import { MachineRoles } from "../settings/MachineRoles";
import { HubMemoryCaps } from "../settings/MemoryCaps";
import { PageHead } from "../settings/parts";
import { useRoute } from "../shell/navigation";
import { toHash, type AdminSection } from "../shell/routes";
import { Invites } from "./Invites";
import { People } from "./People";
import { useHubRole, type HubRoleView } from "./role";
import s from "../settings/settings.module.css";

const SECTIONS: ReadonlyArray<{ section: AdminSection; label: string; icon: ReactNode }> = [
  { section: "people", label: "People", icon: <Users /> },
  { section: "invites", label: "Invites", icon: <UserPlus /> },
  { section: "machines", label: "Machines", icon: <Server /> },
  { section: "hub", label: "Hub settings", icon: <SlidersHorizontal /> },
  { section: "setup", label: "Setup", icon: <ListChecks /> },
];

const useSection = (): AdminSection => {
  const route = useRoute();
  return route.id === "admin" ? route.section : "people";
};

const go = (section: AdminSection) => {
  window.location.hash = toHash({ id: "admin", section });
};

export function AdminSidebar({ onBack }: { onBack: () => void }) {
  const section = useSection();
  return (
    <Sidebar aria-label="Administration">
      <SidebarSection>
        <SidebarItem label="Back" icon={<ArrowLeft />} onClick={onBack} />
      </SidebarSection>
      <SidebarSection title="Administration">
        {SECTIONS.map((x) => (
          <SidebarItem key={x.section} label={x.label} icon={x.icon} current={section === x.section} onClick={() => go(x.section)} />
        ))}
      </SidebarSection>
    </Sidebar>
  );
}

export function AdminScreen() {
  const section = useSection();
  const role = useHubRole();
  return <div className={s.frame}>{page(section, role)}</div>;
}

function page(section: AdminSection, { administers, me, pending, offline }: HubRoleView): ReactNode {
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
      return <Machines />;
    case "hub":
      return <HubSettings />;
    case "setup":
      return <Setup />;
  }
}

/** Adding machines to the hub: this computer, one the hub reaches over SSH, or any other. */
function Machines() {
  return (
    <div className={s.scroll} data-screen="admin.machines">
      <div className={s.column}>
        <PageHead title="Machines">The computers that run this hub's agents. Machine roles are in Hub settings.</PageHead>
        <AddMachine />
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
