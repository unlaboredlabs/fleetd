// Settings' Hub group (#/settings/hub/<page>, D211): the hub's owners' and admins' pages, in the Settings window and
// shown to nobody else; the hub refuses anyone else's change too. People (roles, Invite someone and the invites open,
// and every hub link); Machines (Add machine, the machines with Remove, and Repair for one that isn't well, each one's
// page with its checklist, its role, its screens and its max agents; recordings and cloud machines); Updates
// (UpdatesPage.tsx: where the hub and each machine stand, Update now and Update automatically); Every project, laid out
// as a project's own pages are: Profiles, Tools & skills,
// Instructions & memory and Prompts, each reaching every project on the hub; Hub accounts (the hub's Claude API key
// and its GitHub App, github/AdminGithub.tsx); Vault (the cards, logins and addresses every project uses, and the vault
// key, settings/Vault.tsx); and Setup, the hub's guided steps (setup/SetupScreen.tsx), always listed,
// with how many required ones are left. With several hubs the group manages one hub at a time, named above every page,
// and switches between the hubs this person administers: nothing here acts on a hub the page doesn't name.
import { useState, type ReactNode } from "react";
import { Button, Text, cx } from "../../ui";
import type { HubView } from "../../src/data/hubs";
import { HubScope, useHub, useHubs, useSeveralHubs } from "../../src/data/react";
import { HUB_COLOR } from "../shell/hubColor";
import { AddMachine, type View } from "../addMachine";
import { FleetCapNote } from "../settings/Agents";
import { Recordings } from "../settings/Screens";
import { HubInstructions } from "../settings/Instructions";
import { HubMcpServers } from "../settings/McpServers";
import { EveryProjectFrame } from "../settings/Frames";
import { PageHead, SettingsSection } from "../settings/parts";
import { ProfilesEditor } from "../settings/Profiles";
import { Prompts } from "../settings/Prompts";
import { isEveryProject, type SettingsRoute } from "../settings/route";
import { HubSkills } from "../settings/Skills";
import { HubVault } from "../settings/Vault";
import { AdminGithub } from "../github/AdminGithub";
import { progressLine, SetupSteps, useSetupSteps } from "../setup/SetupScreen";
import { navigate } from "../shell/navigation";
import type { HubTab } from "../shell/routes";
import { ClaudeAdmin } from "./Claude";
import { CloudPart } from "./Cloud";
import { MachineList } from "./MachineList";
import { MachinePage } from "./MachinePage";
import { People } from "./People";
import { UpdatesPage } from "./UpdatesPage";
import { useAdministers, useHubRole, type HubRoleView } from "./role";
import type { Person } from "../../../shared/contracts";
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
      {view.administers && isEveryProject(tab) ? <EveryProjectFrame tab={tab}>{page(tab, route, view)}</EveryProjectFrame> : page(tab, route, view)}
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
    case "hub.updates":
      return <UpdatesPage />;
    case "hub.profiles":
      return <Profiles />;
    case "hub.tools":
      return <ToolsAndSkills />;
    case "hub.instructions":
      return <InstructionsAndMemory />;
    case "hub.prompts":
      return <Prompts where="hub" route={{ tab: "hub.prompts", prompt: route.prompt, for: null, view: route.view }} />;
    case "hub.accounts":
      return <HubAccounts me={me} />;
    case "hub.vault":
      return <HubVault />;
    case "hub.setup":
      return <Setup />;
  }
}

/**
 * Adding machines to the hub (this computer, one the hub reaches over SSH, or any other), then its machines, each with
 * Remove, Repair (which opens in Add machine) while it isn't well, and a page of its own with everything about it; then
 * how long recordings are kept, cloud machines on boat.dev, and updates.
 */
function Machines() {
  const [open, setOpen] = useState<{ view: View; at: number }>();
  return (
    <div className={s.scroll} data-screen="settings.hub.machines">
      <div className={s.column}>
        <PageHead title="Machines">The computers that run this hub&apos;s agents.</PageHead>
        <AddMachine open={open} />
        <MachineList
          onRepair={(r) => {
            setOpen({ view: r, at: Date.now() });
            document.querySelector("section[aria-label='Add machine']")?.scrollIntoView({ block: "nearest" });
          }}
        />
        <FleetCapNote />
        <SettingsSection title="Recordings" reveal="hub.recordings">
          <Recordings />
        </SettingsSection>
        <CloudPart />
      </div>
    </div>
  );
}

/**
 * Every project › Profiles: the task profiles every project's agents run on, each a model, an effort, fast mode and a
 * note, and the hub's default; each project picks which it allows on its Agents page.
 */
function Profiles() {
  return (
    <div className={s.scroll} data-screen="settings.hub.profiles">
      <div className={s.column}>
        <PageHead title="Profiles">The models agents run on. Each project picks which it allows.</PageHead>
        <ProfilesEditor />
      </div>
    </div>
  );
}

/** Every project › Tools & skills: the MCP servers and skills every project's agents get, before a project's own. */
function ToolsAndSkills() {
  return (
    <div className={s.scroll} data-screen="settings.hub.tools">
      <div className={s.column}>
        <PageHead title="Tools & skills">What every project&apos;s agents get. A project&apos;s own come with them, on its Agents page.</PageHead>
        <SettingsSection title="MCP servers" reveal="hub.mcp">
          <HubMcpServers />
        </SettingsSection>
        <HubSkills />
      </div>
    </div>
  );
}

/** Every project › Instructions & memory: the instructions every project's agents get. */
function InstructionsAndMemory() {
  return (
    <div className={s.scroll} data-screen="settings.hub.instructions">
      <div className={s.column}>
        <PageHead title="Instructions & memory">What every project&apos;s agents are told.</PageHead>
        <SettingsSection title="Instructions" reveal="hub.instructions">
          <HubInstructions />
        </SettingsSection>
      </div>
    </div>
  );
}

/**
 * What the hub itself connects to: its Claude API key and its GitHub App, each set up once; and the
 * way back into the guided setup, which walks the same steps.
 */
function HubAccounts({ me }: { me: Person | undefined }) {
  const { id } = useHub();
  return (
    <div className={s.scroll} data-screen="settings.hub.accounts">
      <div className={s.column}>
        <PageHead
          title="Hub accounts"
          aside={
            <Button size="sm" variant="quiet" data-setup-again onClick={() => navigate({ id: "settings", tab: "hub.setup", at: id })}>
              Run guided setup again
            </Button>
          }
        >
          The hub&apos;s own accounts. Each person connects their own Claude and GitHub in You › Your accounts.
        </PageHead>
        <ClaudeAdmin me={me} />
        <AdminGithub />
      </div>
    </div>
  );
}

/**
 * The hub's guided setup: the steps the hub serves, the same as `fleetd init` and the first
 * run, with one open beside them. The open step is this page's own: the route names only the page.
 */
function Setup() {
  const steps = useSetupSteps();
  const [open, setOpen] = useState<string | null>(null);
  const head = (text: string) => <PageHead title="Setup">{text}</PageHead>;
  if (steps === null || "problem" in steps) {
    const text = steps === null ? "Loading…" : steps.old ? "This hub is too old for guided setup. Update fleetd on the hub first." : steps.problem;
    return (
      <div className={s.scroll} data-screen={steps === null ? "settings.hub.setup.loading" : "settings.hub.setup.error"}>
        <div className={s.column}>
          {head("Everything the hub needs, step by step.")}
          <Text tone={steps === null || steps.old ? "quiet" : "danger"}>{text}</Text>
        </div>
      </div>
    );
  }
  return (
    <div className={s.scroll} data-screen="settings.hub.setup">
      <div className={cx(s.column, a.setup)}>
        {head(progressLine(steps.steps))}
        <SetupSteps steps={steps.steps} open={open} onOpen={setOpen} />
      </div>
    </div>
  );
}
