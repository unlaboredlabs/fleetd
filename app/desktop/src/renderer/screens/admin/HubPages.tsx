// Settings' Hub group (#/settings/hub/<page>, D211): the hub's owners' and admins' pages, in the Settings window and
// shown to nobody else; the hub refuses anyone else's change too. People (roles, Invite someone and the invites open,
// and every hub link); Machines (Add machine, the machines with Repair and Remove, each one's page with its checklist,
// their roles, their caps, and Updates: each one's fleetd with Update…); Every project, laid out as a project's own pages are: Profiles, Tools & skills,
// Instructions & memory and Prompts, each reaching every project on the hub; Hub accounts (the hub's Claude API key
// and its GitHub App, github/AdminGithub.tsx); and Setup, the hub's guided steps (setup/SetupScreen.tsx), listed only
// while a required one is left. With several hubs the group manages
// one hub at a time, named above every page, and switches between the hubs this person administers: nothing here acts
// on a hub the page doesn't name.
import { useState, type ReactNode } from "react";
import { Button, Separator, SidebarItem, Switch, Text, Truncate, cx, toast } from "../../ui";
import type { HubView } from "../../src/data/hubs";
import { useData, useDataLayer, useHub, useSeveralHubs } from "../../src/data/react";
import { HUB_COLOR } from "../shell/hubColor";
import { AddMachine, type View } from "../addMachine";
import { HubCaps } from "../settings/Agents";
import { MachineRoles } from "../settings/MachineRoles";
import { HubMemoryCaps } from "../settings/MemoryCaps";
import { SharedMemory } from "../settings/Memory";
import { HubInstructions } from "../settings/Instructions";
import { HubMcpServers } from "../settings/McpServers";
import { PagePart, PageHead } from "../settings/parts";
import { ProfilesEditor } from "../settings/Profiles";
import { Prompts } from "../settings/Prompts";
import type { SettingsRoute } from "../settings/route";
import { HubSkills } from "../settings/Skills";
import { AdminGithub } from "../github/AdminGithub";
import { progressLine, SetupSteps, useSetupSteps } from "../setup/SetupScreen";
import { navigate } from "../shell/navigation";
import { setAutoUpdates, useAutoUpdates } from "../updates/flow";
import { useUpdatesView } from "../updates/hooks";
import { autoWords } from "../updates/model";
import { setUpdatesOpen } from "../updates/state";
import { HubSection } from "../updates/UpdatesSheet";
import type { HubTab } from "../shell/routes";
import { ClaudeAdmin } from "./Claude";
import { MachineList } from "./MachineList";
import { MachinePage } from "./MachinePage";
import { People } from "./People";
import { useAdministers, useHubRole, type HubRoleView } from "./role";
import type { Person } from "../../../shared/contracts";
import s from "../settings/settings.module.css";
import a from "./admin.module.css";

/** A hub's colour as a small mark before its name; none without a colour. */
export const HubMark = ({ hub }: { hub: HubView }) =>
  hub.color === undefined ? null : <span className={a.hubMark} style={{ background: HUB_COLOR[hub.color] }} aria-hidden />;

/** A hub to manage: listed when this person administers it there (and the one managed now, whatever its answer). */
export function HubChoice({ hub, current, onPick }: { hub: HubView; current: boolean; onPick: () => void }) {
  const administers = useAdministers();
  if (!administers && !current) return null;
  return <SidebarItem label={hub.label} icon={<HubMark hub={hub} />} current={current} data-admin-hub={hub.id} onClick={onPick} />;
}

/** The Hub page the route names, for an owner or admin; anyone else who follows a link here is told why not. */
export function HubPage({ tab, route }: { tab: HubTab; route: SettingsRoute }) {
  const role = useHubRole();
  // A fresh snapshot (a machine that just joined brings one) drops hub_info's answer until it is read again: the page
  // stays as the last answer had it meanwhile, so what is open on it (a machine's line, waiting) isn't lost.
  const [settled, setSettled] = useState<HubRoleView>();
  if (!role.pending && (settled?.administers !== role.administers || settled.me !== role.me || settled.offline !== role.offline)) setSettled(role);
  return (
    <>
      <Managing />
      {page(tab, route, role.pending && settled !== undefined ? settled : role)}
    </>
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
      <HubMark hub={hub} />
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
    case "hub.setup":
      return <Setup />;
  }
}

/**
 * Adding machines to the hub (this computer, one the hub reaches over SSH, or any other), then its machines, each with
 * Repair (which opens in Add machine) and Remove, and a page of its own with its checklist; then their roles, and how
 * many agents each machine and all of them together run at once.
 */
function Machines() {
  const [open, setOpen] = useState<{ view: View; at: number }>();
  return (
    <div className={s.scroll} data-screen="settings.hub.machines">
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
        <PagePart title="Max agents" reveal="hub.caps" intro="Every project's agents together: on each machine, and on all of them.">
          <HubCaps />
        </PagePart>
        <Updates />
      </div>
    </div>
  );
}

/** Which fleetd the hub and each machine run, whether each is up to date, the updates sheet, whose Update runs on the
 * hub, and automatic updates (off by default). */
function Updates() {
  const view = useUpdatesView();
  const layer = useDataLayer();
  const { hub } = layer;
  const auto = useAutoUpdates();
  const [saving, setSaving] = useState(false);
  const turn = async (on: boolean) => {
    setSaving(true);
    const refused = await setAutoUpdates(layer, on);
    setSaving(false);
    if (refused !== null) toast({ title: "Automatic updates didn't change", description: refused, tone: "danger" });
  };
  return (
    <PagePart title="Updates" reveal="hub.updates">
      {view.hub === null ? (
        <Text size="sm" tone="quiet">
          Connect to the hub to see its version and its machines&apos;.
        </Text>
      ) : (
        <>
          <HubSection part={view.hub} nodes={view.nodes} />
          <div className={s.inline}>
            <Button variant={view.update === null ? "secondary" : "primary"} onClick={() => setUpdatesOpen(true, hub)}>
              {view.update === null ? "Open updates…" : "Update…"}
            </Button>
            <Text size="xs" tone="quiet">
              Updates the hub, then every machine, then this app.
            </Text>
          </div>
          {auto === null ? null : (
            <Switch
              label="Update automatically"
              description={autoWords(auto.settings.drainMinutes, auto.at, auto.skips)}
              checked={auto.settings.auto}
              disabled={saving}
              onCheckedChange={(on) => void turn(on)}
            />
          )}
        </>
      )}
    </PagePart>
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
        <PageHead title="Profiles">
          What agents run on: a model, a reasoning level and fast mode each, with a note the lead picks by. Every project allows the default; it picks the others on its Agents page.
        </PageHead>
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
        <PagePart title="MCP servers" reveal="hub.mcp">
          <HubMcpServers />
        </PagePart>
        <PagePart title="Skills" reveal="hub.skills" intro="Every project's agents get them, after the project's repo's and its own.">
          <HubSkills />
        </PagePart>
      </div>
    </div>
  );
}

/** Every project › Instructions & memory: the instructions every project's agents get, and how long memory may grow. */
function InstructionsAndMemory() {
  return (
    <div className={s.scroll} data-screen="settings.hub.instructions">
      <div className={s.column}>
        <PageHead title="Instructions & memory">What every project&apos;s agents are told, how much its leads may remember, and the old shared memory.</PageHead>
        <PagePart title="Instructions" reveal="hub.instructions">
          <HubInstructions />
        </PagePart>
        <PagePart title="Memory caps" reveal="hub.memory-caps">
          <HubMemoryCaps />
        </PagePart>
        <PagePart title="Shared memory" reveal="hub.shared-memory" intro="The one memory every lead read before each person had their own. Owners and admins only.">
          <SharedMemory />
        </PagePart>
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
 * The hub's guided setup (docs/design/setup.md): the steps the hub serves, the same as `fleetd init` and the first
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
          {head("Everything the hub needs, step by step: the same steps as fleetd init.")}
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
