// The sidebar: the projects first (alphabetical, so none moves), each opening its lead chat, with an amber dot when
// the lead is waiting for your reply and the number of agents working; then Status, Time, Machines and Settings;
// then the connection. Holding ⌘ (Ctrl)
// shows jump numbers on the first nine projects, which ⌘1..9 open.
import { Activity, Clock, Plus, Server, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { display, type ShortcutId } from "../../../shared/shortcuts";
import { Button, Dot, Kbd, Sidebar as Frame, SidebarItem, SidebarSection, Text, Truncate } from "../../ui";
import { connLine, type SidebarProject } from "./model";
import { sameProject, type Screen } from "./routes";
import s from "./shell.module.css";

const platform = window.fleetd.platform;

const kbd = (id: ShortcutId): ReactNode => <Kbd>{display(id, platform)}</Kbd>;

const TONE = { success: "var(--success)", warning: "var(--warning)", danger: "var(--danger)", quiet: "var(--faint)" } as const;

export interface SidebarProps {
  readonly projects: ReadonlyArray<SidebarProject> | undefined;
  /** Machines not online; undefined until known. */
  readonly machinesDown: number | undefined;
  readonly screen: Screen;
  readonly hub: Parameters<typeof connLine>[0];
  /** ⌘ (Ctrl) is held: show the jump numbers. */
  readonly jumpHints: boolean;
  readonly go: (screen: Screen) => void;
}

const marks = (p: SidebarProject): ReactNode => (
  <>
    {p.needsYou ? <Dot color="var(--warning)" label="The lead is waiting for your reply" /> : null}
    {p.running > 0 ? (
      <span aria-label={`${String(p.running)} ${p.running === 1 ? "agent" : "agents"} working`}>{p.running}</span>
    ) : p.working ? (
      // The lead itself is at work: a still mark, never an animation.
      <Activity className={s.working} aria-label="The lead is working" />
    ) : null}
  </>
);

export function Sidebar({ projects, machinesDown, screen, hub, jumpHints, go }: SidebarProps) {
  const conn = connLine(hub, window.fleetd.fixture !== null);
  const nav = (label: string, icon: ReactNode, target: Screen, current: boolean, trailing?: ReactNode) => (
    <SidebarItem label={label} icon={icon} current={current} trailing={trailing} onClick={() => go(target)} />
  );
  const open = screen.id === "project" || screen.id === "prs" ? screen.project : null;

  return (
    <Frame aria-label="Sidebar">
      <SidebarSection
        title="Projects"
        action={
          <Button variant="quiet" size="sm" icon={<Plus />} onClick={() => go({ id: "projects.add" })}>
            Add
          </Button>
        }
      >
        {projects === undefined ? (
          // Loading (startup, or a resync after the link dropped): never the "no projects" sentence, never old rows.
          // Busy only while something is on its way, not while the hub is unreachable.
          <div className={s.sidebarSkeleton} aria-busy={hub?.phase === "live" || hub?.phase === "connecting"} aria-label="Loading projects">
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
              key={`${p.key.machineId}/${p.key.projectId}`}
              label={p.title}
              current={sameProject(open, p.key)}
              className={p.needsYou ? s.strong : undefined}
              trailing={
                <>
                  {marks(p)}
                  {jumpHints && i < 9 ? <span className={s.jump}>{i + 1}</span> : null}
                </>
              }
              onClick={() => go({ id: "project", project: p.key, message: null })}
            />
          ))
        )}
      </SidebarSection>

      <SidebarSection>
        {nav("Status", <Activity />, { id: "status" }, screen.id === "status", kbd("status.toggle"))}
        {nav("Time", <Clock />, { id: "time", orderId: null }, screen.id === "time")}
        {nav(
          "Machines",
          <Server />,
          { id: "machines" },
          screen.id === "machines",
          machinesDown !== undefined && machinesDown > 0 ? <Text size="xs" tone="warning">{`${String(machinesDown)} down`}</Text> : undefined,
        )}
        {nav("Settings", <Settings />, { id: "settings", tab: "general" }, screen.id === "settings", kbd("settings.open"))}
      </SidebarSection>

      <button type="button" className={s.conn} onClick={() => go({ id: "settings", tab: "general" })}>
        <Dot color={TONE[conn.tone]} />
        <Truncate size="xs" tone="quiet" expand="none">
          {conn.label}
        </Truncate>
      </button>
    </Frame>
  );
}
