// New screen (D239): a person opens a browser, an iOS simulator, an Android emulator or a Linux desktop of their own,
// for a project or a Navi. A short picker: the kind, as four tiles, then the machine that can host it, each with its
// slots in words; a full one offers to wait for its next slot, which goes to people before agents. It opens in the
// panel's live view with the person in control; a wait shows in the Screens list until its screen opens. Opened from
// the top of the Screens tab and from the palette's "New screen…", for the project on screen.
import { AppWindow, Globe, Monitor, Smartphone, TabletSmartphone } from "lucide-react";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, Dialog, Radio, RadioGroup, Text, cx } from "../../ui";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { useCommands } from "../palette";
import { HubText } from "../projects/HubText";
import { isNavi } from "../navi/model";
import { projectKey } from "../../src/data/store";
import { currentRoute, navigate } from "../shell/navigation";
import { panelRoute, type ProjectKey } from "../shell/routes";
import { canOpen, hostsFor, KINDS, openWord, pickHost, slotLine, type ScreenKind } from "./newScreen";
import s from "./sessions.module.css";

/** The hub feature that says it opens people's screens. */
export const NEW_SCREEN = "screen_open";

const ICON: Readonly<Record<ScreenKind, ReactNode>> = {
  browser: <Globe aria-hidden />,
  ios: <Smartphone aria-hidden />,
  android: <TabletSmartphone aria-hidden />,
  linux_desktop: <Monitor aria-hidden />,
};

// The project the picker is open for, if it is: one picker for the window.
let shown: ProjectKey | null = null;
const listeners = new Set<() => void>();
const set = (project: ProjectKey | null) => {
  shown = project;
  for (const l of listeners) l();
};

/** Opens the picker for `project`. */
export const openNewScreen = (project: ProjectKey): void => set(project);

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

/** The project on screen, if the route has one. */
const routeProject = (): ProjectKey | undefined => {
  const r = currentRoute();
  return r.id === "project" || r.id === "session" ? r.project : undefined;
};

/** Mounted once, beside the palette: the picker when it is open, and the palette's "New screen…". */
export function NewScreenHost() {
  const project = useSyncExternalStore(subscribe, () => shown);
  const served = useData((d) => d.features.includes(NEW_SCREEN));
  useCommands(
    [
      {
        id: "screen.new",
        title: "New screen…",
        detail: "Open a browser, a simulator, an emulator or a desktop of your own, for this project",
        group: "actions",
        keywords: ["browser", "ios", "iphone", "simulator", "android", "emulator", "linux", "desktop", "session"],
        enabled: () => served && routeProject() !== undefined,
        run: () => {
          const p = routeProject();
          if (p !== undefined) openNewScreen(p);
        },
      },
    ],
    [served],
  );
  return project === null ? null : <NewScreenDialog key={`${project.machineId}/${project.projectId}`} project={project} onClose={() => set(null)} />;
}

/** The New screen button at the top of the Screens tab. */
export function NewScreenButton({ project }: { project: ProjectKey }) {
  const served = useData((d) => d.features.includes(NEW_SCREEN));
  if (!served) return null;
  return (
    <Button variant="secondary" size="sm" icon={<AppWindow aria-hidden />} onClick={() => openNewScreen(project)}>
      New screen
    </Button>
  );
}

const noInput = {};

export function NewScreenDialog({ project, onClose }: { project: ProjectKey; onClose: () => void }) {
  const layer = useDataLayer();
  const navi = useData((d) => {
    const p = d.projects[projectKey(project)];
    return p !== undefined && isNavi(p) ? p.title : undefined;
  });
  const roles = useToolQuery("machine_roles", noInput);
  const machines = roles.data?.machines ?? [];
  const naviHome = navi === undefined ? undefined : project.machineId;
  const [kind, setKind] = useState<ScreenKind>("browser");
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fix?: string | undefined } | null>(null);
  const hosts = hostsFor(machines, kind, naviHome);
  const host = pickHost(hosts, picked);

  const open = async () => {
    if (busy || host === undefined) return;
    setBusy(true);
    setError(null);
    const out = await layer.call(
      "screen_open",
      { projectRef: { machineId: project.machineId, projectId: project.projectId }, kind, machineId: host.machineId, wait: host.full },
      { timeoutMs: 120_000 },
    );
    setBusy(false);
    if (!out.ok) {
      setError({ message: out.error.message, fix: out.error.fix });
      return;
    }
    void layer.queryClient.invalidateQueries({ queryKey: ["call", "browser_sessions"] });
    onClose();
    const session = out.output.session;
    navigate(panelRoute(project, session === undefined ? { tab: "sessions", session: null } : { tab: "sessions", session: session.sessionId }));
  };

  const loading = roles.data === undefined;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="New screen"
      description={
        navi !== undefined && kind === "browser"
          ? `A browser on ${navi}’s saved sign-ins: sites you sign in to stay signed in for ${navi}. You’re in control; it ends when you close it or after 30 minutes idle.`
          : "You’re in control from the start. It’s recorded like agents’ screens, and ends when you close it or after 30 minutes idle."
      }
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || host === undefined || !host.online} onClick={() => void open()}>
            {busy ? "Opening…" : openWord(host)}
          </Button>
        </>
      }
    >
      <div className={s.picker} data-screen="sessions.new">
        <div className={s.kinds} role="radiogroup" aria-label="Kind of screen">
          {KINDS.map((k) => {
            const able = loading || canOpen(machines, k.kind, naviHome);
            return (
              <button
                key={k.kind}
                type="button"
                role="radio"
                aria-checked={kind === k.kind}
                className={cx(s.kind, kind === k.kind && s.kindOn)}
                disabled={!able || busy}
                title={able ? undefined : "No machine can host it yet"}
                onClick={() => {
                  setKind(k.kind);
                  setError(null);
                }}
              >
                <span className={s.kindIcon}>{ICON[k.kind]}</span>
                <Text size="sm" strong>
                  {k.label}
                </Text>
                <Text size="xs" tone="quiet">
                  {k.line}
                </Text>
              </button>
            );
          })}
        </div>
        <div className={s.hosts}>
          <Text id="screen-host" size="xs" tone="quiet">
            On
          </Text>
          {loading ? (
            <Text size="sm" tone="quiet">
              Reading machines…
            </Text>
          ) : hosts.length === 0 ? (
            <Text size="sm" tone="quiet">
              No machine can host this yet. A hub admin turns screens on for a machine in Settings › Hub › Machines.
            </Text>
          ) : (
            <RadioGroup value={host?.machineId ?? ""} onValueChange={setPicked} disabled={busy} aria-labelledby="screen-host">
              {hosts.map((h) => (
                <Radio
                  key={h.machineId}
                  value={h.machineId}
                  label={h.name}
                  disabled={!h.online}
                  description={
                    <Text size="xs" tone={h.full && h.online ? "warning" : "inherit"}>
                      {slotLine(h)}
                    </Text>
                  }
                />
              ))}
            </RadioGroup>
          )}
        </div>
        {error === null ? null : (
          <div role="alert">
            <Text size="sm" tone="danger">
              <HubText>{error.message}</HubText>
            </Text>
            {error.fix === undefined ? null : (
              <Text as="p" size="sm" tone="quiet">
                <HubText>{error.fix}</HubText>
              </Text>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
