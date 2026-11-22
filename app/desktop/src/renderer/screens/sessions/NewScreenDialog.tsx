// New screen's picker itself (NewScreen.tsx says what it does): loaded on first use, or once the app is idle, so the
// first load carries only its host and button.
import { Globe, Laptop, Monitor, Smartphone, TabletSmartphone } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Dialog, Radio, RadioGroup, Select, Text, Tooltip, cx } from "../../ui";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { selectProjects } from "../../src/data/selectors";
import { HubText } from "../projects/HubText";
import { navigate } from "../shell/navigation";
import { useHubRole } from "../admin/role";
import { revealNext } from "../settings/reveal";
import { panelRoute, type ProjectKey, type Screen as Route } from "../shell/routes";
import type { BrowserSession, BrowserSessionsOutput } from "../../../shared/contracts";
import {
  adminNames,
  askLine,
  fixLabel,
  fixPlace,
  hostsFor,
  idleFor,
  idleWords,
  KINDS,
  kindLine,
  newScreenOf,
  NO_PR,
  openingLine,
  openWord,
  pickHost,
  pickModel,
  pickRuntime,
  prChoices,
  profileBusy,
  simModels,
  slotLine,
  startingLine,
  takesBuild,
  whyOff,
  type OffReason,
  type ScreenKind,
} from "./pickScreen";
import { screenMark } from "./timing";
import s from "./sessions.module.css";

/** How long an open with no stage line stays quiet; then the footer says what is starting. */
const SLOW_MS = 1_200;
/** How long the picker follows the list for a screen the hub's answer left out. */
const FOLLOW_MS = 15_000;

const ICON: Readonly<Record<ScreenKind, ReactNode>> = {
  browser: <Globe aria-hidden />,
  ios: <Smartphone aria-hidden />,
  android: <TabletSmartphone aria-hidden />,
  linux_desktop: <Monitor aria-hidden />,
  mac: <Laptop aria-hidden />,
};

const noInput = {};

const keyOf = (p: ProjectKey) => `${p.machineId}/${p.projectId}`;

/** Where an opened screen shows: the Screens page's own view when the picker was opened there, else the panel's. */
const viewOf = (project: ProjectKey, session: string, anyBot: boolean): Route =>
  anyBot ? { id: "screens", open: { project, session } } : panelRoute(project, { tab: "sessions", session });

export function NewScreenDialog({ project: start, anyBot = false, onClose }: { project: ProjectKey; anyBot?: boolean; onClose: () => void }) {
  const layer = useDataLayer();
  // Opened for any bot (the Screens page), the bot is a pick of its own; else it is the project it was opened for.
  const bots = useData(selectProjects);
  const [botPicked, setBot] = useState(keyOf(start));
  const bot = anyBot ? bots?.find((b) => keyOf(b) === botPicked) : undefined;
  const machineId = bot?.machineId ?? start.machineId;
  const projectId = bot?.projectId ?? start.projectId;
  const project: ProjectKey = useMemo(() => ({ machineId, projectId }), [machineId, projectId]);
  const roles = useToolQuery("machine_roles", noInput);
  const machines = roles.data?.machines ?? [];
  // A browser opens on the project's own machine, with its saved sign-ins.
  const home = project.machineId;
  const [kind, setKind] = useState<ScreenKind>("browser");
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fix?: string | undefined } | null>(null);
  const hosts = hostsFor(machines, kind, home);
  const host = pickHost(hosts, picked);
  const idle = idleWords(idleFor(machines, host?.machineId, kind));
  // An iPhone's model and OS, from the simulators its Mac reports; none from a Mac before them, which starts a plain one.
  const models = kind === "ios" ? simModels(machines, host?.machineId) : [];
  const [modelPicked, setModel] = useState<string | null>(null);
  const [runtimePicked, setRuntime] = useState<string | null>(null);
  const model = pickModel(models, modelPicked);
  const runtime = pickRuntime(model, runtimePicked);
  const projectRef = { machineId: project.machineId, projectId: project.projectId };
  // A PR's build only where the kind can open: else the picker says why instead.
  const offersPr = takesBuild(kind) && hosts.length > 0;
  const prs = useToolQuery("pr_list", { projectRef }, { enabled: offersPr });
  const choices = prChoices(prs.data?.prs ?? []);
  const [prPicked, setPr] = useState(NO_PR);
  const pr = offersPr ? choices.find((c) => c.value === prPicked) : undefined;
  // An open with a PR's build going in, followed until the screen is the person's.
  // An open followed until the screen is the person's: a PR's build going in, or an iPhone starting on the Mac.
  const [opening, setOpening] = useState<{ readonly waitId: string; readonly threadId?: string; readonly pr?: number; readonly machine: string } | null>(null);
  // Read while the picker is open: the screens there at the press, then the one it opened, when the answer leaves it out.
  const listed = useToolQuery("browser_sessions", { projectRef });
  const row = opening === null ? undefined : listed.data?.waits?.find((w) => w.waitId === opening.waitId);
  const [following, setFollowing] = useState<{ readonly known: ReadonlySet<string>; readonly kind: ScreenKind } | null>(null);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!busy) return undefined;
    const timer = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => {
      window.clearTimeout(timer);
      setSlow(false);
    };
  }, [busy]);
  const live = (session: BrowserSession) => {
    onClose();
    screenMark("opened", session.sessionId);
    navigate(viewOf(project, session.sessionId, anyBot));
  };
  const found = following === null ? undefined : newScreenOf(listed.data?.sessions ?? [], following.kind, following.known);
  useEffect(() => {
    if (found === undefined) return;
    onClose();
    screenMark("opened", found.sessionId);
    navigate(viewOf(project, found.sessionId, anyBot));
  }, [found, onClose, project, anyBot]);
  useEffect(() => {
    if (following === null) return undefined;
    const timer = window.setTimeout(() => {
      onClose();
      navigate(panelRoute(project, { tab: "sessions", session: null }));
    }, FOLLOW_MS);
    return () => window.clearTimeout(timer);
  }, [following, onClose, project]);
  const ready =
    opening === null || row !== undefined
      ? undefined
      : listed.data?.sessions.find((x) => x.threadId === opening.threadId && x.state === "live" && x.control === "human");
  useEffect(() => {
    if (ready === undefined) return;
    onClose();
    navigate(viewOf(project, ready.sessionId, anyBot));
  }, [ready, onClose, project, anyBot]);
  const failed = row?.stage === "failed";
  // The browser's tile says which profile it opens on: the bot's, signed in, or a fresh one while that one is in use.
  const busyProfile = profileBusy(listed.data?.sessions ?? [], home);

  const close = () => {
    // A failed one is said here: its row in Screens goes with the picker.
    if (opening !== null && failed) void layer.call("screen_end", { waitId: opening.waitId });
    onClose();
  };

  const open = async () => {
    if (busy) return;
    if (host === undefined) return;
    screenMark("click");
    setBusy(true);
    setError(null);
    // The screens there at the press: the one this open makes is the one that wasn't (read now, if not read yet).
    const before = listed.data ?? (await layer.queryClient.query(layer.toolQuery("browser_sessions", { projectRef })).catch(() => undefined));
    const known = new Set((before?.sessions ?? []).map((x) => x.sessionId));
    const out = await layer
      .call(
        "screen_open",
        {
          projectRef,
          kind,
          machineId: host.machineId,
          wait: host.full,
          ...(pr === undefined ? {} : { pr: { repo: pr.repo, number: pr.number } }),
          ...(model === undefined ? {} : { sim: { model: model.id, ...(runtime === undefined ? {} : { runtime: runtime.id }) } }),
        },
        { timeoutMs: 120_000 },
      )
      .catch((e: unknown) => ({ ok: false as const, error: { message: e instanceof Error ? e.message : String(e), fix: undefined } }));
    if (!out.ok) {
      setBusy(false);
      setError({ message: out.error.message, fix: out.error.fix });
      return;
    }
    const { session, waiting } = out.output;
    // In the list before the view mounts, so the view has it, and watches it, from its first render.
    if (session !== undefined) {
      layer.queryClient.setQueryData<BrowserSessionsOutput>(layer.toolQuery("browser_sessions", { projectRef }).queryKey, (old) =>
        old === undefined || old.sessions.some((x) => x.sessionId === session.sessionId) ? old : { ...old, sessions: [session, ...old.sessions] },
      );
    }
    void layer.queryClient.invalidateQueries({ queryKey: ["call", "browser_sessions"] });
    if (session === undefined && waiting === undefined) {
      // Opened, but the answer left it out: it shows in the list in a moment, and the picker opens it from there.
      setFollowing({ known, kind });
      return;
    }
    setBusy(false);
    // Past its wait already (a PR's build going in), or an iPhone, which the hub starts in its own time, in the Mac's
    // line: followed here until it is yours.
    if (waiting !== undefined && ((pr !== undefined && waiting.stage !== undefined && waiting.stage !== "waiting") || kind === "ios")) {
      setOpening({
        waitId: waiting.waitId,
        ...(waiting.threadId === undefined ? {} : { threadId: waiting.threadId }),
        ...(pr === undefined ? {} : { pr: pr.number }),
        machine: host.name,
      });
      return;
    }
    if (session !== undefined) {
      live(session);
      return;
    }
    onClose();
    navigate(panelRoute(project, { tab: "sessions", session: null }));
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
        footer={
          <Tooltip prose content={failed ? "Its row under Screens goes with it." : "It carries on under Screens until it’s yours."}>
            <Button variant={failed ? "primary" : "quiet"} onClick={close}>
              Close
            </Button>
          </Tooltip>
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
      wide="medium"
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="New screen"
      footer={
        <>
          {busy && slow ? (
            <span className={s.starting} role="status">
              <Text size="sm" tone="quiet">
                {startingLine(kind)}
              </Text>
            </span>
          ) : null}
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Tooltip prose content={`${pr === undefined ? "" : `#${String(pr.number)}’s newest CI build goes in first. `}It ends when you close it or ${idle}.`}>
            <Button variant="primary" disabled={busy || host === undefined || !host.online} onClick={() => void open()}>
              {busy ? "Opening…" : openWord(host)}
            </Button>
          </Tooltip>
        </>
      }
    >
      <div className={s.picker} data-screen="sessions.new">
        <div className={s.kinds} role="radiogroup" aria-label="Kind of screen">
          {KINDS.map((k) => {
            const off = loading ? null : whyOff(machines, k.kind, home);
            return (
              <button
                key={k.kind}
                type="button"
                role="radio"
                aria-checked={kind === k.kind}
                className={cx(s.kind, kind === k.kind && s.kindOn, off !== null && s.kindOff)}
                data-off={off?.fix}
                disabled={busy}
                onClick={() => {
                  setKind(k.kind);
                  setError(null);
                }}
              >
                <span className={s.kindIcon}>{ICON[k.kind]}</span>
                <Text size="sm" strong>
                  {k.label}
                </Text>
                <Text size="xs" tone={off === null ? "quiet" : "warning"}>
                  {off === null ? kindLine(k, busyProfile) : off.short}
                </Text>
              </button>
            );
          })}
        </div>
        {anyBot && bots !== undefined ? (
          <div className={s.field}>
            <Text size="xs" tone="quiet">
              Bot
            </Text>
            <Select
              aria-label="Bot"
              value={keyOf(project)}
              onValueChange={(v) => {
                setBot(v);
                setPicked(null);
                setPr(NO_PR);
                setError(null);
              }}
              disabled={busy}
              options={bots.map((b) => ({ value: keyOf(b), label: b.title }))}
            />
          </div>
        ) : null}
        <div className={s.field}>
          <Text id="screen-host" size="xs" tone="quiet">
            Machine
          </Text>
          {loading ? (
            <Text size="sm" tone="quiet">
              Reading machines…
            </Text>
          ) : hosts.length === 0 ? (
            <OffLine kind={kind} reason={whyOff(machines, kind, home)} onLeave={onClose} />
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
        {models.length === 0 || model === undefined ? null : (
          <div className={s.fieldRow}>
            <div className={s.field}>
              <Text id="screen-model" size="xs" tone="quiet">
                Model
              </Text>
              <Select
                aria-label="Model"
                value={model.id}
                onValueChange={(v) => {
                  setModel(v);
                  setError(null);
                }}
                disabled={busy}
                options={models.map((m) => ({ value: m.id, label: m.name }))}
              />
            </div>
            <div className={s.field}>
              <Text id="screen-os" size="xs" tone="quiet">
                OS
              </Text>
              <Select
                aria-label="OS"
                value={runtime?.id}
                onValueChange={(v) => {
                  setRuntime(v);
                  setError(null);
                }}
                disabled={busy}
                options={model.runtimes.map((r) => ({ value: r.id, label: r.name }))}
              />
            </div>
          </div>
        )}
        {offersPr ? (
          <div className={s.field}>
            <Text id="screen-pr" size="xs" tone="quiet">
              PR build
            </Text>
            <Select
              aria-label="PR build"
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
                  The bot’s PRs couldn’t be read{prs.error instanceof Error && prs.error.message !== "" ? `: ${prs.error.message}` : "."}
                </Text>
                <Button variant="quiet" size="sm" disabled={prs.isFetching} onClick={() => void prs.refetch()}>
                  {prs.isFetching ? "Retrying…" : "Retry"}
                </Button>
              </div>
            ) : prs.data === undefined || choices.length === 0 ? (
              <Text size="xs" tone="quiet">
                {prs.data === undefined ? "Reading the bot’s PRs…" : (prs.data.githubError ?? "The bot has no open PRs.")}
              </Text>
            ) : null}
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

/** Why the kind picked can't open, from the machines' nodes, and its one fix: an admin's button, a member's who to ask. */
function OffLine({ kind, reason, onLeave }: { kind: ScreenKind; reason: OffReason | null; onLeave: () => void }) {
  const { administers } = useHubRole();
  const people = useToolQuery("people_list", noInput, { enabled: !administers && reason !== null });
  if (reason === null) return null;
  const label = administers ? fixLabel(reason.fix) : null;
  const ask = administers ? null : askLine(reason, kind, adminNames(people.data?.people ?? []));
  const act = () => {
    const { tab, reveal } = fixPlace(reason.fix);
    onLeave();
    revealNext(reveal);
    navigate(tab === "hub.machines" && reason.fix === "roles" && reason.machine !== undefined ? { id: "settings", tab, machine: reason.machine.machineId } : { id: "settings", tab });
  };
  return (
    <div className={s.offReason} data-off-reason={reason.fix}>
      <div>
        <Text as="p" size="sm">
          {reason.why}
        </Text>
        {ask === null ? null : (
          <Text as="p" size="xs" tone="quiet">
            {ask}
          </Text>
        )}
      </div>
      {label === null ? null : (
        <Button size="sm" variant="secondary" onClick={act}>
          {label}
        </Button>
      )}
    </div>
  );
}

