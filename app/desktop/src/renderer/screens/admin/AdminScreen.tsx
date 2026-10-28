// Administration (#/admin/<section>): the hub's owners' and admins' page, apart from Settings so nobody else ever sees
// an admin control (D186). Five pages (D209): People (roles, Invite someone and the invites open, and every hub link),
// Machines (Add machine, the machines with Repair and Remove, each one's page with its checklist, and machine roles),
// Connections (the hub's Claude API key, its own GitHub App, github/AdminGithub.tsx, and its Google OAuth client for
// Navis, google/AdminGoogle.tsx), Hub settings (everything that reaches every project: the fleet and machine caps, task
// profiles, memory caps, the instructions, MCP servers, skills and prompts for every project) and Setup, last, with how
// many required steps are left (the hub's guided setup, setup/SetupScreen.tsx). The shell shows AdminSidebar in the
// sidebar's place while it is open, as it does Settings'; the hub-wide prompts nest under Hub settings there, as
// Settings' Prompts nest theirs. With several hubs (docs/design/hubs.md) it manages one hub at a time, named above
// every page, and its sidebar switches between the hubs this person administers: nothing here acts on a hub the page
// doesn't name.
import { ArrowLeft, ListChecks, Plug, Server, SlidersHorizontal, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Separator, Sidebar, SidebarItem, SidebarSection, Text, Truncate, cx } from "../../ui";
import type { HubView } from "../../src/data/hubs";
import { HubScope, useData, useHub, useHubs, useSeveralHubs, useToolQuery } from "../../src/data/react";
import { HUB_COLOR } from "../shell/hubColor";
import { AddMachine, type View } from "../addMachine";
import { HubCaps } from "../settings/Agents";
import { MachineRoles } from "../settings/MachineRoles";
import { HubMemoryCaps } from "../settings/MemoryCaps";
import { HUB } from "../settings/editor";
import { HubInstructions } from "../settings/Instructions";
import { HubMcpServers } from "../settings/McpServers";
import { PagePart, PageHead } from "../settings/parts";
import { Prompts } from "../settings/Prompts";
import { PromptNav } from "../settings/SettingsSidebar";
import { HubSkills } from "../settings/Skills";
import { AdminGithub } from "../github/AdminGithub";
import { AdminGoogle } from "../google/AdminGoogle";
import { progressLine, SetupSteps, useSetupSteps } from "../setup/SetupScreen";
import { navigate, useRoute } from "../shell/navigation";
import type { AdminSection, SettingsView } from "../shell/routes";
import { ClaudeAdmin } from "./Claude";
import { MachineList } from "./MachineList";
import { MachinePage } from "./MachinePage";
import { People } from "./People";
import { useAdministers, useHubRole, type HubRoleView } from "./role";
import type { Person } from "../../../shared/contracts";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

const SECTIONS: ReadonlyArray<{ section: AdminSection; label: string; icon: ReactNode }> = [
  { section: "people", label: "People", icon: <Users /> },
  { section: "machines", label: "Machines", icon: <Server /> },
  { section: "connections", label: "Connections", icon: <Plug /> },
  { section: "hub", label: "Hub settings", icon: <SlidersHorizontal /> },
  { section: "setup", label: "Setup", icon: <ListChecks /> },
];

const noInput = {};

const useSection = (): AdminSection => {
  const route = useRoute();
  return route.id === "admin" ? route.section : "people";
};

/** The hub-wide prompt open on Hub settings, and its view. */
const usePrompt = (): { prompt: string | null; view: SettingsView } => {
  const route = useRoute();
  return route.id === "admin" ? { prompt: route.prompt ?? null, view: route.view ?? "edit" } : { prompt: null, view: "edit" };
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
  const { prompt } = usePrompt();
  const { id } = useHub();
  const hubs = useHubs();
  const administers = useAdministers();
  const setup = useToolQuery("setup_list", noInput, { enabled: administers });
  const left = setup.data?.requiredLeft ?? 0;
  return (
    <Sidebar aria-label="Administration">
      <SidebarSection>
        <SidebarItem label="Back" icon={<ArrowLeft />} onClick={onBack} />
      </SidebarSection>
      <SidebarSection title="Administration">
        {SECTIONS.map((x) => (
          <div key={x.section} className={s.navGroup}>
            <SidebarItem
              label={x.label}
              icon={x.icon}
              current={section === x.section && prompt === null}
              trailing={x.section === "setup" && left > 0 ? <Text size="xs" tone="warning">{`${String(left)} left`}</Text> : undefined}
              onClick={() => go(x.section, id)}
            />
            {x.section === "hub" && section === "hub" && administers ? (
              <PromptNav selected={prompt} scope={HUB} onOpen={(p) => navigate({ id: "admin", section: "hub", prompt: p, at: id })} />
            ) : null}
          </div>
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
  const prompt = usePrompt();
  const role = useHubRole();
  // A fresh snapshot (a machine that just joined brings one) drops hub_info's answer until it is read again: the page
  // stays as the last answer had it meanwhile, so what is open on it (a machine's line, waiting) isn't lost.
  const [settled, setSettled] = useState<HubRoleView>();
  if (!role.pending && (settled?.administers !== role.administers || settled.me !== role.me || settled.offline !== role.offline)) setSettled(role);
  return (
    <div className={s.frame}>
      <Managing />
      {page(section, machine, prompt, role.pending && settled !== undefined ? settled : role)}
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

function page(
  section: AdminSection,
  machine: string | undefined,
  prompt: { prompt: string | null; view: SettingsView },
  { administers, me, pending, offline }: HubRoleView,
): ReactNode {
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
    case "machines":
      return machine === undefined ? <Machines /> : <MachinePage machineId={machine} />;
    case "connections":
      return <Connections me={me} />;
    case "hub":
      return prompt.prompt === null ? <HubSettings /> : <Prompts where="admin" route={{ tab: "prompts", prompt: prompt.prompt, for: null, view: prompt.view }} />;
    case "setup":
      return <Setup />;
  }
}

/**
 * Adding machines to the hub (this computer, one the hub reaches over SSH, or any other), then its machines, each with
 * Repair (which opens in Add machine) and Remove, and a page of its own with its checklist; then their roles.
 */
function Machines() {
  const [open, setOpen] = useState<{ view: View; at: number }>();
  return (
    <div className={s.scroll} data-screen="admin.machines">
      <div className={s.column}>
        <PageHead title="Machines">The computers that run this hub&apos;s agents.</PageHead>
        <AddMachine open={open} />
        <Separator />
        <MachineList
          onRepair={(r) => {
            setOpen({ view: r, at: Date.now() });
            document.querySelector("section[aria-label='Add machine']")?.scrollIntoView({ block: "nearest" });
          }}
        />
        <Separator />
        <MachineRoles />
      </div>
    </div>
  );
}

/** What the hub itself connects to: its Claude API key, its GitHub App and its Google client, each set up once. */
function Connections({ me }: { me: Person | undefined }) {
  return (
    <div className={s.scroll} data-screen="admin.connections">
      <div className={s.column}>
        <PageHead title="Connections">The hub&apos;s own accounts. Each person connects their own Claude and GitHub in Settings › Connections.</PageHead>
        <ClaudeAdmin me={me} />
        <AdminGithub />
        <AdminGoogle />
      </div>
    </div>
  );
}

/**
 * Everything hub-wide: it reaches every project and machine, so only an owner or admin changes it, and the hub refuses
 * anyone else (D209). Its prompts are listed under it in the sidebar; one opens in the editor in this page's place.
 */
function HubSettings() {
  return (
    <div className={s.scroll} data-screen="admin.hub">
      <div className={s.column}>
        <PageHead title="Hub settings">What reaches every project and machine on this hub. A project&apos;s own settings come after these.</PageHead>
        <PagePart title="Agents" reveal="admin.hub.agents">
          <HubCaps />
          <Separator />
          <HubMemoryCaps />
        </PagePart>
        <PagePart title="Instructions" reveal="admin.hub.instructions">
          <HubInstructions />
        </PagePart>
        <PagePart title="MCP servers" reveal="admin.hub.mcp">
          <HubMcpServers />
        </PagePart>
        <PagePart title="Skills" reveal="admin.hub.skills" intro="Every project's agents get them, after the project's repo's and its own.">
          <HubSkills />
        </PagePart>
        <PagePart title="Prompts" reveal="admin.hub.prompts" intro="The texts fleetd sends every project's agents. Pick one under Hub settings in the sidebar to edit it; a project's own edits are in its settings." />
      </div>
    </div>
  );
}

/**
 * The hub's guided setup (docs/design/setup.md): the steps the hub serves, the same as `fleetd init` and the first
 * run, with one open beside them. The open step is this page's own: the route names only the section.
 */
function Setup() {
  const steps = useSetupSteps();
  const [open, setOpen] = useState<string | null>(null);
  const head = (text: string) => <PageHead title="Setup">{text}</PageHead>;
  if (steps === null || "problem" in steps) {
    const text = steps === null ? "Loading…" : steps.old ? "This hub is too old for guided setup. Update fleetd on the hub first." : steps.problem;
    return (
      <div className={s.scroll} data-screen={steps === null ? "admin.setup.loading" : "admin.setup.error"}>
        <div className={s.column}>
          {head("Everything the hub needs, step by step: the same steps as fleetd init.")}
          <Text tone={steps === null || steps.old ? "quiet" : "danger"}>{text}</Text>
        </div>
      </div>
    );
  }
  return (
    <div className={s.scroll} data-screen="admin.setup">
      <div className={cx(s.column, a.setup)}>
        {head(progressLine(steps.steps))}
        <SetupSteps steps={steps.steps} open={open} onOpen={setOpen} />
      </div>
    </div>
  );
}
