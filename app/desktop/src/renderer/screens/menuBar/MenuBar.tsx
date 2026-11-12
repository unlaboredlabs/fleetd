// The agents' Mac's menu bar popover (`#/menubar`, src/main/menuBar.ts): what agents do on this Mac now, its health
// with a fix each, and Update while it is behind (model.ts). Main reads the Mac every couple of seconds while it shows;
// the Mac's screen and the names come from the hub this app is signed in to at the Mac's hub, through the same data
// layer as the app's windows. Take over is the session view's own (setControl, then its window); so is Hand back.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Copy, Ellipsis, Hammer, Monitor, Smartphone } from "lucide-react";
import type { MacMenuBarRead } from "../../../shared/macMenuBar";
import type { MacSetupFailure } from "../../../shared/macSetup";
import { HubScope, useData, useDataLayer, useHubs } from "../../src/data/react";
import { selectLiveAgents, selectProjects } from "../../src/data/selectors";
import { Button, copyText, Text, toast } from "../../ui";
import { useScreens } from "../screensPage/data";
import { isLive } from "../sessions/model";
import { setControl } from "../sessions/live";
import { showWindow } from "../sessions/windows";
import { menuBarView, READ_EVERY_MS, type Fix, type HealthRow, type HubInput, type ScreenInput, type ScreenView, type UseRow, type View } from "./model";
import s from "./menuBar.module.css";

const onVisibility = (change: () => void) => {
  document.addEventListener("visibilitychange", change);
  return () => document.removeEventListener("visibilitychange", change);
};
const isVisible = () => document.visibilityState === "visible";

/** Main's read of the Mac: at once, then every READ_EVERY_MS while the popover shows; undefined until the first. */
export function useMacRead(): MacMenuBarRead | null | undefined {
  const [read, setRead] = useState<MacMenuBarRead | null | undefined>(undefined);
  const visible = useSyncExternalStore(onVisibility, isVisible);
  useEffect(() => {
    if (!visible) return undefined;
    let live = true;
    let reading = false;
    const tick = () => {
      if (reading) return;
      reading = true;
      void window.fleetd.menuBar
        .read()
        .then((r) => {
          if (live) setRead(r);
        })
        .finally(() => {
          reading = false;
        });
    };
    tick();
    const timer = window.setInterval(tick, READ_EVERY_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [visible]);
  return read;
}

const NO_NAMES: ReadonlyMap<string, string> = new Map();

/** The Mac's screen and the names, from the hub. The screen a person has comes first, then one asking, then the oldest. */
function useHubInput(): HubInput {
  const screens = useScreens();
  const agents = useData(selectLiveAgents);
  const projects = useData(selectProjects);
  return useMemo(() => {
    const mac = screens.filter((p) => p.kind === "mac" && isLive(p.x));
    const rank = (state: string) => (state === "yours" ? 0 : state === "asking" ? 1 : 2);
    const first = [...mac].sort((a, b) => rank(a.x.state) - rank(b.x.state))[0];
    const screen: ScreenInput | null =
      first === undefined
        ? null
        : {
            id: first.x.id,
            project: first.x.projectRef,
            projectTitle: first.project.title,
            who: first.x.openedBy ?? first.x.agent.title,
            person: first.x.openedBy !== undefined,
            state: first.x.state,
            ...(first.x.handoff === undefined ? {} : { asks: first.x.handoff.reason }),
          };
    const names = new Map<string, string>();
    for (const a of agents ?? []) if (a.row.taskId !== undefined) names.set(a.row.taskId, a.row.title);
    const titles = new Map<string, string>();
    for (const p of projects ?? []) titles.set(p.projectId, p.title);
    return { screen, agents: names.size === 0 ? NO_NAMES : names, projects: titles };
  }, [screens, agents, projects]);
}

/** The popover's window: on the hub this app is signed in to at the Mac's hub, else on the Mac's own read alone. */
export function MenuBarWindow() {
  const read = useMacRead();
  const hubs = useHubs();
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") void window.fleetd.menuBar.hide();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  const hubId = read?.hubId ?? null;
  const hub = hubId === null ? undefined : hubs.find((h) => h.id === hubId);
  if (read === undefined) return <Frame screen="menu-bar.loading" />;
  if (read === null) return <NotJoined />;
  if (hub === undefined) return <Popover read={read} hub={null} />;
  return (
    <HubScope key={hub.id} hub={hub}>
      <WithHub read={read} />
    </HubScope>
  );
}

function WithHub({ read }: { read: MacMenuBarRead }) {
  const layer = useDataLayer();
  const hub = useHubInput();
  const take = async (screen: ScreenInput, to: "human" | "agent") => {
    if (!(await setControl(layer, screen.id, to))) return;
    if (to === "human") {
      showWindow(screen.project, screen.id, layer.hub);
      void window.fleetd.menuBar.hide();
    }
  };
  return (
    <Popover
      read={read}
      hub={hub}
      onScreen={(screen, action) => {
        if (action === "open") {
          showWindow(screen.project, screen.id, layer.hub);
          void window.fleetd.menuBar.hide();
          return Promise.resolve();
        }
        return take(screen, action === "takeOver" ? "human" : "agent");
      }}
    />
  );
}

/** The popover's frame: it tells main its height as it lays out, so the window fits what it shows. */
function Frame({ screen, children }: { screen: string; children?: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (el === null || typeof ResizeObserver === "undefined") return undefined;
    let last = 0;
    const observer = new ResizeObserver(() => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (height === last || height < 80) return;
      last = height;
      void window.fleetd.menuBar.fit(height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={root} className={s.root} data-screen={screen}>
      {children}
    </div>
  );
}

function NotJoined() {
  return (
    <Frame screen="menu-bar.not-joined">
      <div className={s.section}>
        <Text strong>This Mac isn’t the agents’ Mac</Text>
        <Text size="xs" tone="quiet">
          Set it up from a code that Add machine › A Mac for agents shows on your main machine.
        </Text>
        <div className={s.actions}>
          <Button size="sm" variant="secondary" onClick={() => void window.fleetd.macSetup.open()}>
            Set up this Mac
          </Button>
        </div>
      </div>
    </Frame>
  );
}

type ScreenAction = "takeOver" | "handBack" | "open";

/** The popover itself, from main's read (its clock too) and the hub's side when there is one. */
export function Popover({ read, hub, onScreen }: { read: MacMenuBarRead; hub: HubInput | null; onScreen?: (screen: ScreenInput, action: ScreenAction) => Promise<void> }) {
  const view: View = menuBarView(read, hub, read.health.now);
  const idle = view.screen.kind !== "held" && view.simulators.length === 0 && view.builds.length === 0;
  return (
    <Frame screen="menu-bar">
      <header className={s.head}>
        <div className={s.headText}>
          <Text strong>{view.title}</Text>
          <Text size="xs" tone="quiet">
            {view.subtitle}
          </Text>
        </div>
        <Button variant="quiet" size="sm" iconOnly icon={<Ellipsis aria-hidden />} aria-label="More" onClick={() => void window.fleetd.menuBar.menu()} />
      </header>

      <section className={s.section} aria-label="Now">
        <h2 className={s.heading}>Now</h2>
        <ScreenLine view={view.screen} onScreen={onScreen} />
        {view.simulators.map((r) => (
          <UseLine key={r.key} row={r} icon={<Smartphone aria-hidden />} />
        ))}
        {view.builds.map((r) => (
          <UseLine key={r.key} row={r} icon={<Hammer aria-hidden />} />
        ))}
        {view.simulators.length === 0 && view.builds.length === 0 ? (
          <Text size="xs" tone="quiet" className={s.empty}>
            {idle ? "No agent is using this Mac." : "No simulators or builds running."}
          </Text>
        ) : null}
      </section>

      <section className={s.section} aria-label="Health">
        <h2 className={s.heading}>Health</h2>
        <ul className={s.checks}>
          {view.health.map((row) => (
            <Check key={row.id} row={row} />
          ))}
        </ul>
      </section>

      {view.update === null ? null : <UpdateSection update={view.update} hubUrl={read.found.hubUrl} />}
    </Frame>
  );
}

function ScreenLine({ view, onScreen }: { view: ScreenView; onScreen: ((screen: ScreenInput, action: ScreenAction) => Promise<void>) | undefined }) {
  const [busy, setBusy] = useState(false);
  if (view.kind === "unknown") {
    return (
      <div className={s.use}>
        <span className={s.icon}>
          <Monitor aria-hidden />
        </span>
        <div className={s.useText}>
          <Text size="sm">Screen</Text>
          <Text size="xs" tone="quiet">
            Sign in to {view.hubName} in this app to see who has it and take over.
          </Text>
        </div>
      </div>
    );
  }
  const held = view.kind === "held" ? view : null;
  const label = held?.action === "takeOver" ? "Take over" : held?.action === "handBack" ? "Hand back" : held?.action === "open" ? "Watch" : null;
  return (
    <div className={s.use} data-tone={held?.tone}>
      <span className={s.icon}>
        <Monitor aria-hidden />
      </span>
      <div className={s.useText}>
        <Text size="sm">Screen</Text>
        <Text size="xs" tone={held?.tone === "warn" ? "warning" : held?.tone === "ok" ? "success" : "quiet"} className={s.clamp}>
          {held === null ? "Nobody has it." : held.line}
        </Text>
      </div>
      {held === null || label === null || onScreen === undefined || held.action === null ? null : (
        <Button
          size="sm"
          variant={held.action === "takeOver" && held.tone === "warn" ? "primary" : "secondary"}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onScreen(held.screen, held.action as ScreenAction).finally(() => setBusy(false));
          }}
        >
          {label}
        </Button>
      )}
    </div>
  );
}

function UseLine({ row, icon }: { row: UseRow; icon: React.ReactNode }) {
  return (
    <div className={s.use}>
      <span className={s.icon}>{icon}</span>
      <div className={s.useText}>
        <Text size={row.mono === true ? "xs" : "sm"} mono={row.mono === true} className={s.ellipsis} title={row.title}>
          {row.title}
        </Text>
        <Text size="xs" tone="quiet" className={s.ellipsis}>
          {row.who}
        </Text>
      </div>
      <Text size="xs" tone="faint" className={s.since}>
        {row.since}
      </Text>
    </div>
  );
}

function Check({ row }: { row: HealthRow }) {
  return (
    <li className={s.check} data-tone={row.tone}>
      <div className={s.checkLine}>
        <Text size="sm">{row.title}</Text>
        <Text size="xs" className={s.word} tone={row.tone === "fail" ? "danger" : row.tone === "warn" ? "warning" : row.tone === "quiet" ? "faint" : "quiet"}>
          {row.word}
        </Text>
      </div>
      {row.detail === undefined ? null : (
        <Text as="p" size="xs" tone="quiet" className={s.detail}>
          {row.detail}
        </Text>
      )}
      {row.fix === undefined ? null : <FixLine fix={row.fix} />}
    </li>
  );
}

const FIX_LABEL = { restart: "Restart the node", grant: "Allow in System Settings", open: "Open the App Store" } as const;

function FixLine({ fix }: { fix: Fix }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<MacSetupFailure | null>(null);
  if (fix.kind === "say") {
    return (
      <Text as="p" size="xs" className={s.detail}>
        {fix.text}
      </Text>
    );
  }
  if (fix.kind === "command") {
    return (
      <div className={s.command}>
        <Text as="p" size="xs" className={s.detail}>
          {fix.where}:
        </Text>
        <div className={s.code}>
          <code data-selectable>{fix.command}</code>
          <Button
            variant="quiet"
            size="sm"
            iconOnly
            icon={<Copy aria-hidden />}
            aria-label="Copy the command"
            onClick={() => {
              void copyText(fix.command);
              toast({ title: "Copied", key: "menu-bar:copied" });
            }}
          />
        </div>
      </div>
    );
  }
  const run = () => {
    setBusy(true);
    setFailure(null);
    const done = fix.kind === "restart" ? window.fleetd.macSetup.restart() : window.fleetd.macSetup.openPane(fix.pane);
    void done.then((outcome) => {
      setBusy(false);
      if (!outcome.ok) setFailure(outcome.failure);
    });
  };
  return (
    <div className={s.actions}>
      <Button size="sm" variant="secondary" disabled={busy} onClick={run}>
        {busy && fix.kind === "restart" ? "Restarting…" : FIX_LABEL[fix.kind]}
      </Button>
      {failure === null ? null : (
        <div role="alert">
          <Text as="p" size="xs" tone="danger">
            {failure.message} {failure.fix ?? ""}
          </Text>
        </div>
      )}
    </div>
  );
}

function UpdateSection({ update, hubUrl }: { update: NonNullable<View["update"]>; hubUrl: string }) {
  const [state, setState] = useState<"idle" | "busy" | "started" | MacSetupFailure>("idle");
  return (
    <section className={s.section} aria-label="Update">
      <h2 className={s.heading}>Update</h2>
      <Text as="p" size="xs">
        {update.line}
      </Text>
      {!update.admin ? (
        <Text as="p" size="xs" tone="quiet">
          {update.where}
        </Text>
      ) : state === "started" ? (
        <div role="status">
          <Text as="p" size="xs" tone="quiet">
            Updating: this Mac takes the hub’s build once its agents finish their step.
          </Text>
        </div>
      ) : (
        <div className={s.actions}>
          <Button
            size="sm"
            variant="primary"
            disabled={state === "busy"}
            onClick={() => {
              setState("busy");
              void window.fleetd.macSetup.updateHub(hubUrl).then((out) => setState(out.ok ? "started" : out.failure));
            }}
          >
            Update
          </Button>
          {typeof state === "object" ? (
            <div role="alert">
              <Text as="p" size="xs" tone="danger">
                {state.message} {state.fix ?? ""}
              </Text>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
