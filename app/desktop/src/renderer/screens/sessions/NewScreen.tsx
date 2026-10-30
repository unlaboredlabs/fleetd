// New screen (D239): a person opens a browser, an iOS simulator, an Android emulator or a Linux desktop of their own,
// for a project or a Navi. A short picker: the kind, as four tiles, then the machine that can host it, each with its
// slots in words; a full one offers to wait for its next slot, which goes to people before agents. It opens in the
// panel's live view with the person in control; a wait shows in the Screens list until its screen opens.
//
// A PR, optionally: an iOS or Android screen takes its CI build, which the hub installs before the person gets it. That
// goes on in the hub (a slow simulator can take minutes): the picker follows it from the Screens list's row and lands
// in the live view once the screen is theirs; closed meanwhile, the row shows in Screens until then. A project's browser
// with a PR opens the PR's Try it preview instead: it runs on the project's machine, in a browser of the person's own,
// on the PR's Try it tab. Opened from the top of the Screens tab and from the palette's "New screen…".
import { AppWindow, Globe, Monitor, Smartphone, TabletSmartphone } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, Dialog, Radio, RadioGroup, Select, Text, cx } from "../../ui";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { useCommands } from "../palette";
import { HubText } from "../projects/HubText";
import { isNavi } from "../navi/model";
import { projectKey } from "../../src/data/store";
import { currentRoute, navigate } from "../shell/navigation";
import { panelRoute, type ProjectKey } from "../shell/routes";
import { refusalWords } from "../tryit/hub";
import { openTry } from "../tryit/open";
import { canOpen, hostsFor, KINDS, NO_PR, openingLine, openWord, pickHost, prChoices, slotLine, takesBuild, takesPr, type ScreenKind } from "./pickScreen";
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
  const projectRef = { machineId: project.machineId, projectId: project.projectId };
  const offersPr = takesPr(kind, navi !== undefined);
  const prs = useToolQuery("pr_list", { projectRef }, { enabled: offersPr });
  const choices = prChoices(prs.data?.prs ?? []);
  const [prPicked, setPr] = useState(NO_PR);
  const pr = offersPr ? choices.find((c) => c.value === prPicked) : undefined;
  // A browser with a PR is the PR's Try it preview, on the project's own machine: no machine to pick.
  const web = kind === "browser" && pr !== undefined;
  // An open with a PR's build going in, followed until the screen is the person's.
  const [opening, setOpening] = useState<{ readonly waitId: string; readonly threadId?: string; readonly pr: number; readonly machine: string } | null>(null);
  const listed = useToolQuery("browser_sessions", { projectRef }, { enabled: opening !== null });
  const row = opening === null ? undefined : listed.data?.waits?.find((w) => w.waitId === opening.waitId);
  const ready =
    opening === null || row !== undefined
      ? undefined
      : listed.data?.sessions.find((x) => x.threadId === opening.threadId && x.state === "live" && x.control === "human");
  useEffect(() => {
    if (ready === undefined) return;
    onClose();
    navigate(panelRoute(project, { tab: "sessions", session: ready.sessionId }));
  }, [ready, onClose, project]);
  const failed = row?.stage === "failed";

  const close = () => {
    // A failed one is said here: its row in Screens goes with the picker.
    if (opening !== null && failed) void layer.call("screen_end", { waitId: opening.waitId });
    onClose();
  };

  const openPreview = async (of: { readonly repo: string; readonly number: number }) => {
    setBusy(true);
    setError(null);
    const out = await layer.call("preview_start", { projectRef, of: { kind: "pr", repo: of.repo, number: of.number }, target: "web" });
    setBusy(false);
    if (!out.ok) {
      setError({ message: refusalWords(out.error) });
      return;
    }
    void layer.queryClient.invalidateQueries({ queryKey: ["call", "previews_list"] });
    onClose();
    openTry(project, of.repo, of.number);
  };

  const open = async () => {
    if (busy) return;
    if (web) return openPreview(pr);
    if (host === undefined) return;
    setBusy(true);
    setError(null);
    const out = await layer
      .call(
        "screen_open",
        { projectRef, kind, machineId: host.machineId, wait: host.full, ...(pr === undefined ? {} : { pr: { repo: pr.repo, number: pr.number } }) },
        { timeoutMs: 120_000 },
      )
      .catch((e: unknown) => ({ ok: false as const, error: { message: e instanceof Error ? e.message : String(e), fix: undefined } }));
    setBusy(false);
    if (!out.ok) {
      setError({ message: out.error.message, fix: out.error.fix });
      return;
    }
    void layer.queryClient.invalidateQueries({ queryKey: ["call", "browser_sessions"] });
    const waiting = out.output.waiting;
    // Past its wait already (a PR's build going in): followed here until it is yours.
    if (waiting !== undefined && waiting.stage !== undefined && waiting.stage !== "waiting" && pr !== undefined) {
      setOpening({ waitId: waiting.waitId, ...(waiting.threadId === undefined ? {} : { threadId: waiting.threadId }), pr: pr.number, machine: host.name });
      return;
    }
    onClose();
    const session = out.output.session;
    navigate(panelRoute(project, session === undefined ? { tab: "sessions", session: null } : { tab: "sessions", session: session.sessionId }));
  };

  const loading = roles.data === undefined;
  if (opening !== null) {
    return (
      <Dialog
        open
        onOpenChange={(o) => {
          if (!o) close();
        }}
        title="New screen"
        description="It’s yours once the build is in. Close this and it carries on: it shows under Screens until then."
        footer={
          <Button variant={failed ? "primary" : "quiet"} onClick={close}>
            Close
          </Button>
        }
      >
        <div className={s.picker} data-screen="sessions.new" data-opening={row?.stage ?? "ready"}>
          <div role={failed ? "alert" : "status"}>
            <Text size="sm" tone={failed ? "danger" : "inherit"}>
              {openingLine(row?.stage, opening.pr, opening.machine)}
            </Text>
          </div>
          {failed && row.error !== undefined ? (
            <Text as="p" size="sm" tone="quiet">
              <HubText>{row.error}</HubText>
            </Text>
          ) : null}
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="New screen"
      description={
        web
          ? "The PR’s app in a browser of your own, as Try it runs it. It ends when you press End, or when no one uses it."
          : navi !== undefined && kind === "browser"
            ? `A browser on ${navi}’s saved sign-ins: sites you sign in to stay signed in for ${navi}. You’re in control; it ends when you close it or after 30 minutes idle.`
            : "You’re in control from the start. It’s recorded like agents’ screens, and ends when you close it or after 30 minutes idle."
      }
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || (!web && (host === undefined || !host.online))} onClick={() => void open()}>
            {busy ? (web ? "Starting…" : "Opening…") : web ? "Open preview" : openWord(host)}
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
        {web ? null : (
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
        )}
        {offersPr ? (
          <div className={s.hosts}>
            <Text id="screen-pr" size="xs" tone="quiet">
              {takesBuild(kind) ? "PR build" : "PR preview"}
            </Text>
            <Select
              aria-label={takesBuild(kind) ? "PR build" : "PR preview"}
              value={pr?.value ?? NO_PR}
              onValueChange={(v) => {
                setPr(v);
                setError(null);
              }}
              disabled={busy || prs.data === undefined}
              options={[{ value: NO_PR, label: "None" }, ...choices.map((c) => ({ value: c.value, label: c.label }))]}
            />
            {prs.isError ? (
              <div className={s.prError} role="alert">
                <Text size="xs" tone="danger">
                  The project’s PRs couldn’t be read{prs.error instanceof Error && prs.error.message !== "" ? `: ${prs.error.message}` : "."}
                </Text>
                <Button variant="quiet" size="sm" disabled={prs.isFetching} onClick={() => void prs.refetch()}>
                  {prs.isFetching ? "Retrying…" : "Retry"}
                </Button>
              </div>
            ) : (
              <Text size="xs" tone="quiet">
                {prs.data === undefined
                  ? "Reading the project’s PRs…"
                  : pr !== undefined
                    ? web
                      ? `Opens #${String(pr.number)}’s Try it preview: it builds and runs on the project’s machine, in a browser of your own on its Try it tab.`
                      : "Its newest CI build is installed before you get control."
                    : choices.length === 0
                      ? (prs.data.githubError ?? "The project has no open PRs.")
                      : takesBuild(kind)
                        ? "Optional: an open PR whose CI build to install."
                        : "Optional: an open PR to try in its preview."}
              </Text>
            )}
          </div>
        ) : null}
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
