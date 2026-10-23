// The sidebar: the projects first (alphabetical, so none moves), each opening its lead chat and saying why it wants
// you ("reply", "approve", "secret", "blocked") or how many agents work; a chat with a message you haven't seen is
// bold. Then Agents, Pull requests (of the project on screen, else the last one opened), Status, Time, Machines and
// Settings; then any update to make, and the connection. Holding ⌘ (Ctrl) shows jump numbers
// on the first nine projects, which ⌘1..9 open.
import { Activity, Bot, Clock, GitPullRequest, Plus, Server, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { display, type ShortcutId } from "../../../shared/shortcuts";
import { Button, Dot, Kbd, Sidebar as Frame, SidebarItem, SidebarSection, Text, Tooltip, Truncate } from "../../ui";
import { UpdatesLine } from "../updates";
import { connLine, routeOf, type SidebarProject } from "./model";
import { useOfflineAsOf } from "./offline";
import { sameProject, type ProjectKey, type Screen } from "./routes";
import s from "./shell.module.css";

const platform = window.fleetd.platform;

const kbd = (id: ShortcutId): ReactNode => <Kbd>{display(id, platform)}</Kbd>;

const TONE = { success: "var(--success)", warning: "var(--warning)", danger: "var(--danger)", quiet: "var(--faint)" } as const;

export interface SidebarProps {
  readonly projects: ReadonlyArray<SidebarProject> | undefined;
  /** Agents at work across the projects; undefined until known. */
  readonly agentsWorking: number | undefined;
  /** The project Pull requests opens; null with no projects. */
  readonly prsProject: ProjectKey | null;
  /** Machines not online; undefined until known. */
  readonly machinesDown: number | undefined;
  readonly screen: Screen;
  readonly hub: Parameters<typeof connLine>[0];
  /** ⌘ (Ctrl) is held: show the jump numbers. */
  readonly jumpHints: boolean;
  readonly go: (screen: Screen) => void;
}

const UNREAD = "New message from the lead";

/** The row's one mark: why it wants you, else a new message, else how many agents work. */
const mark = (p: SidebarProject): { readonly node: ReactNode; readonly tip: string } | null => {
  const want = p.want;
  if (want !== undefined) {
    if (want.word === "blocked") {
      return { node: <Text size="xs" tone="danger">blocked</Text>, tip: want.label };
    }
    return {
      node: (
        <>
          <Dot color="var(--warning)" />
          {want.word === undefined ? null : (
            <Text size="xs" tone="warning">
              {want.word}
            </Text>
          )}
          {want.count > 1 ? <span>{`· ${String(want.count)}`}</span> : null}
        </>
      ),
      tip: want.label,
    };
  }
  if (p.unread) return { node: <Dot color="var(--accent)" label={UNREAD} />, tip: UNREAD };
  if (p.running > 0) return { node: `${String(p.running)} working`, tip: `${String(p.running)} ${p.running === 1 ? "agent" : "agents"} working` };
  if (p.working) return { node: "working", tip: "The lead is working" };
  return null;
};

/** Offline the marks are the last known ones, and their words say since when (`asOf`, "as of 09:02"). */
const trailing = (p: SidebarProject, jump: number | null, asOf: string | undefined): ReactNode => {
  const m = mark(p);
  const tip = m === null || asOf === undefined ? m?.tip : `${m.tip}, ${asOf}`;
  return (
    <>
      {m === null ? null : (
        <Tooltip content={tip}>
          <span className={s.mark} aria-label={tip}>
            {m.node}
          </span>
        </Tooltip>
      )}
      {jump !== null ? <span className={s.jump}>{jump}</span> : null}
    </>
  );
};

export function Sidebar({ projects, agentsWorking, prsProject, machinesDown, screen, hub, jumpHints, go }: SidebarProps) {
  const asOf = useOfflineAsOf();
  const conn = connLine(hub, window.fleetd.fixture !== null, asOf);
  const nav = (label: string, icon: ReactNode, target: Screen, current: boolean, trailing?: ReactNode) => (
    <SidebarItem label={label} icon={icon} current={current} trailing={trailing} onClick={() => go(target)} />
  );
  const open = screen.id === "project" ? screen.project : null;

  return (
    <Frame
      aria-label="Sidebar"
      footer={
        <div className={s.footer}>
          <UpdatesLine />
          <button type="button" className={s.conn} onClick={() => go({ id: "settings", tab: "general" })}>
            <Dot color={TONE[conn.tone]} />
            <Truncate size="xs" tone="quiet" expand="none">
              {conn.label}
            </Truncate>
          </button>
        </div>
      }
    >
      <SidebarSection
        title={asOf === undefined ? "Projects" : `Projects, ${asOf}`}
        action={
          <Button variant="quiet" size="sm" icon={<Plus />} onClick={() => go({ id: "projects.add" })}>
            Add
          </Button>
        }
      >
        {projects === undefined ? (
          // Loading (startup, or a resync after the link dropped): never the "no projects" sentence, never old rows.
          // Busy only while something is on its way, not while the hub is unreachable.
          <div className={s.sidebarSkeleton} aria-busy={hub.phase === "live" || hub.phase === "connecting"} aria-label="Loading projects">
            <span />
            <span />
            <span />
          </div>
        ) : projects.length === 0 ? (
          <Text as="p" size="xs" tone="quiet" className={s.sidebarNote}>
            No projects yet. Add one: a GitHub repo, or a folder on one of your machines.
          </Text>
        ) : (
          projects.map((p, i) => (
            <SidebarItem
              key={p.key}
              label={p.project.title}
              current={sameProject(open, p.project)}
              emphasis={p.unread}
              trailing={trailing(p, jumpHints && i < 9 ? i + 1 : null, asOf)}
              onClick={() => go({ id: "project", project: routeOf(p), message: null })}
            />
          ))
        )}
      </SidebarSection>

      <SidebarSection>
        {nav(
          "Agents",
          <Bot />,
          { id: "agents", agent: null },
          screen.id === "agents",
          agentsWorking !== undefined && agentsWorking > 0 ? `${String(agentsWorking)} working` : undefined,
        )}
        {prsProject !== null ? nav("Pull requests", <GitPullRequest />, { id: "prs", project: prsProject, pr: null }, screen.id === "prs") : null}
        {nav("Status", <Activity />, { id: "status" }, screen.id === "status", kbd("status.toggle"))}
        {nav("Time", <Clock />, { id: "time", orderId: null }, screen.id === "time")}
        {nav(
          "Machines",
          <Server />,
          { id: "machines" },
          screen.id === "machines",
          machinesDown !== undefined && machinesDown > 0 ? <Text size="xs" tone="warning">{`${String(machinesDown)} down`}</Text> : undefined,
        )}
        {/* Settings' Back returns focus here when this opened it. */}
        <SidebarItem
          label="Settings"
          icon={<Settings />}
          current={screen.id === "settings"}
          trailing={kbd("settings.open")}
          data-opens="settings"
          onClick={() => go({ id: "settings", tab: "general" })}
        />
      </SidebarSection>
    </Frame>
  );
}
