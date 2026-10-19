// The sidebar (spec 2.6): Status, Board, Machines and Time, then every project with its open orders beneath it,
// then the connection. The amber dot means something there needs you; the quiet number is the project's running
// agents. Holding ⌘ (Ctrl) shows jump numbers on the first nine orders, which ⌘1..9 open.
import { Activity, Clock, LayoutGrid, Plus, Server } from "lucide-react";
import type { ReactNode } from "react";
import { display } from "../../../shared/shortcuts";
import { Button, Dot, Kbd, Sidebar as Frame, SidebarItem, SidebarSection, Text, Truncate } from "../../ui";
import { connLine, sidebarOrders, type Seen, type ShellData } from "./model";
import { sameProject, type Route, type Screen } from "./routes";
import s from "./shell.module.css";

const platform = window.fleetd.platform;

const TONE = { success: "var(--success)", warning: "var(--warning)", danger: "var(--danger)", quiet: "var(--faint)" } as const;

export interface SidebarProps {
  readonly data: ShellData;
  readonly route: Route;
  readonly seen: Seen;
  readonly hub: Parameters<typeof connLine>[0];
  /** ⌘ (Ctrl) is held: show the jump numbers. */
  readonly jumpHints: boolean;
  readonly go: (screen: Screen) => void;
}

export function Sidebar({ data, route, seen, hub, jumpHints, go }: SidebarProps) {
  const screen = route.screen;
  const conn = connLine(hub, window.fleetd.fixture !== null);
  const nav = (label: string, icon: ReactNode, target: Screen, current: boolean, trailing?: ReactNode) => (
    <SidebarItem label={label} icon={icon} current={current} trailing={trailing} onClick={() => go(target)} />
  );
  const jumpOf = new Map(sidebarOrders(data.projects).map((id, i) => [id, i + 1]));

  return (
    <Frame aria-label="Sidebar">
      <SidebarSection>
        {nav("Status", <Activity />, { id: "status", scope: { kind: "fleet" } }, screen.id === "status", <Kbd>{display("status.toggle", platform)}</Kbd>)}
        {nav("Board", <LayoutGrid />, { id: "board", project: null }, screen.id === "board" && screen.project === null, <Kbd>{display("board.open", platform)}</Kbd>)}
        {nav(
          "Machines",
          <Server />,
          { id: "machines" },
          screen.id === "machines",
          data.machinesDown > 0 ? <Text size="xs" tone="warning">{`${String(data.machinesDown)} down`}</Text> : undefined,
        )}
        {nav("Time", <Clock />, { id: "time", orderId: null }, screen.id === "time" && screen.orderId === null)}
      </SidebarSection>

      <SidebarSection
        title="Projects"
        action={
          <Button variant="quiet" size="sm" icon={<Plus />} onClick={() => go({ id: "projects.add" })}>
            Add
          </Button>
        }
      >
        {data.projects === undefined ? (
          // Loading (startup, or a resync after the link dropped): never the "no projects" sentence, never old rows.
          // Busy only while something is on its way, not while the hub is unreachable.
          <div className={s.sidebarSkeleton} aria-busy={hub?.phase === "live" || hub?.phase === "connecting"} aria-label="Loading projects">
            <span />
            <span />
            <span />
          </div>
        ) : data.projects.length === 0 ? (
          <Text as="p" size="xs" tone="quiet" className={s.sidebarNote}>
            No projects yet. Add one: a GitHub repo, or a folder on one of your machines.
          </Text>
        ) : null}
        {data.projects?.map((p) => {
          const selected = screen.id === "board" && sameProject(screen.project, p.key);
          const unread = !selected && seen.unread(p.key, p.lastActivityAt);
          return (
            <div key={`${p.key.machineId}/${p.key.projectId}`} className={s.project}>
              <SidebarItem
                label={p.title}
                current={selected}
                className={p.needsYou > 0 ? s.strong : p.orders.length === 0 && !selected ? s.quiet : undefined}
                icon={<span className={s.unread} data-on={unread || undefined} aria-label={unread ? "New activity" : undefined} />}
                trailing={
                  <>
                    {p.needsYou > 0 ? <Dot color="var(--warning)" label={`${String(p.needsYou)} need you`} /> : null}
                    {p.stalled && p.needsYou === 0 ? <Text size="xs" tone="warning">stalled</Text> : null}
                    {p.running > 0 ? <span aria-label={`${String(p.running)} agents running`}>{p.running}</span> : null}
                  </>
                }
                // Picking the project you're on clears the filter, as on the board's own project chips.
                onClick={() => go({ id: "board", project: selected ? null : p.key })}
              />
              {p.orders.map((o) => {
                const jump = jumpOf.get(o.id) ?? 0;
                const hint = jumpHints && jump <= 9 ? String(jump) : null;
                const open = screen.id === "order" && screen.orderId === o.id;
                return (
                  <SidebarItem
                    key={o.id}
                    indent
                    label={o.title}
                    current={open}
                    className={o.needsYou ? s.strong : open ? undefined : s.quiet}
                    icon={<span className={s.orderId}>{o.id}</span>}
                    trailing={
                      <>
                        {o.needsYou ? <Dot color="var(--warning)" label="Needs you" /> : null}
                        {hint === null ? null : <span className={s.jump}>{hint}</span>}
                      </>
                    }
                    onClick={() => go({ id: "order", orderId: o.id, at: null })}
                  />
                );
              })}
            </div>
          );
        })}
      </SidebarSection>

      <button
        type="button"
        className={s.conn}
        onClick={() => go({ id: "settings", tab: "general" })}
        {...(screen.id === "settings" ? { "aria-current": "page" as const } : {})}
      >
        <Dot color={TONE[conn.tone]} />
        <Truncate size="xs" tone="quiet" expand="none">
          {conn.label}
        </Truncate>
      </button>
    </Frame>
  );
}
