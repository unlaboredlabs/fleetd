// Screens (D305), a page of its own: every live and recent screen of the projects you can see, as a wall.
// What asks for you is on top, its picture large enough to read, with Take over beside it; then every live screen as a
// picture with its project, kind and machine, state, who has it and what its agent did last; then the ended ones as a
// list. New screen is one sentence under the title (Open a browser on devbox for storefront). The pictures are the
// hub's, a few a minute, and come only while the page shows (useThumbFeed).
//
// A screen opens on the page's own route (#/screens/<machine>/<project>/<id>): D278's view takes the page, with a way
// back to the wall.
import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, EmptyState, FrameTitle, Select, Text, Truncate, toast } from "../../ui";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { selectProjects } from "../../src/data/selectors";
import { useNow } from "../live/clock";
import { navigate } from "../shell/navigation";
import { panelRoute, type ProjectKey } from "../shell/routes";
import { setControl } from "../sessions/live";
import { SessionView } from "../sessions/SessionView";
import { isLive } from "../sessions/model";
import { NEW_SCREEN } from "../sessions/NewScreen";
import { hostsFor, KINDS, openWord, pickHost, whyOff, type ScreenKind } from "../sessions/pickScreen";
import type { BrowserSessionsOutput } from "../../../shared/contracts";
import { placeLine, split, useScreens, useThumbFeed, type PageScreen } from "./data";
import { Doing, Meta, openHref, openRoute, Thumb } from "./parts";
import s from "./page.module.css";

export function ScreensPage({ open }: { open: { project: ProjectKey; session: string } | null }) {
  const all = useScreens();
  const now = useNow(all.some((p) => isLive(p.x)));
  // Pictures only for the wall: an open screen's view has its own live frames.
  useThumbFeed(open === null);
  if (open !== null) {
    return (
      <div className={s.screen} data-screen="screens.view">
        <FrameTitle title="Screens" />
        <div className={s.viewWrap}>
          <SessionView key={open.session} project={open.project} id={open.session} onBack={() => navigate({ id: "screens", open: null })} />
        </div>
      </div>
    );
  }
  return <Wall all={all} now={now} />;
}

/** The title's quiet line: how many are live, and how many need you. */
export const countLine = (all: readonly PageScreen[]): string => {
  const { asking, live } = split(all);
  const n = asking.length + live.length;
  return `${String(n)} live${asking.length === 0 ? "" : ` · ${String(asking.length)} ${asking.length === 1 ? "needs" : "need"} you`}`;
};

function Heading({ title, count, tone = "quiet" }: { title: string; count: number; tone?: "quiet" | "warning" }) {
  return (
    <h2 className={s.heading}>
      <Text size="xs" tone={tone} strong>
        {title}
      </Text>
      <Text size="xs" tone="faint" tabular>
        {String(count)}
      </Text>
    </h2>
  );
}

function Wall({ all, now }: { all: readonly PageScreen[]; now: number }) {
  const { asking, live, recent } = split(all);
  const opens = useData((d) => d.features.includes(NEW_SCREEN));
  const [composing, setComposing] = useState(false);
  return (
    <div className={s.screen} data-screen="screens.page">
      <FrameTitle title="Screens" detail={countLine(all)}>
        {opens ? (
          <Button variant="secondary" size="sm" icon={<Plus aria-hidden />} onClick={() => setComposing((c) => !c)} aria-expanded={composing}>
            New screen
          </Button>
        ) : null}
      </FrameTitle>
      <div className={s.body}>
        {composing ? <OpenLine onClose={() => setComposing(false)} /> : null}
        {all.length === 0 ? (
          <EmptyState title="No screens yet">When an agent opens a browser, a device or the agents’ Mac, or you open one with New screen, it shows here.</EmptyState>
        ) : null}
        {asking.length === 0 ? null : (
          <Group title="Needs you" count={asking.length} tone="warning">
            {asking.map((p) => (
              <AskingRow key={p.x.id} screen={p} now={now} />
            ))}
          </Group>
        )}
        {live.length === 0 ? null : (
          <Group title="Live" count={live.length}>
            <div className={s.grid}>
              {live.map((p) => (
                <Tile key={p.x.id} screen={p} now={now} />
              ))}
            </div>
          </Group>
        )}
        {recent.length === 0 ? null : (
          <Group title="Recent" count={recent.length}>
            <Recent recent={recent} now={now} />
          </Group>
        )}
      </div>
    </div>
  );
}

function Group({ title, count, tone, children }: { title: string; count: number; tone?: "quiet" | "warning"; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <Heading title={title} count={count} {...(tone === undefined ? {} : { tone })} />
      {children}
    </section>
  );
}

/** One that asks for you: its picture at a size to read, why it asks, and Take over beside it, which takes control and opens it. */
function AskingRow({ screen: p, now }: { screen: PageScreen; now: number }) {
  const layer = useDataLayer();
  return (
    <div className={s.asking} data-state={p.x.state}>
      <a className={s.askingPic} href={openHref(p)} aria-label={`Open ${p.x.purpose}`}>
        <Thumb screen={p} />
      </a>
      <div className={s.askingText}>
        <a className={s.titleLink} href={openHref(p)}>
          <Truncate size="md" strong expand="none">
            {p.x.purpose}
          </Truncate>
        </a>
        <Meta screen={p} now={now} />
        <span className={s.reason}>
          <Doing screen={p} />
        </span>
        <span className={s.askingActions}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              void setControl(layer, p.x.id, "human");
              navigate(openRoute(p));
            }}
          >
            Take over
          </Button>
          <Text size="xs" tone="faint">
            opens it with you in control
          </Text>
        </span>
      </div>
    </div>
  );
}

/** A live one: whose it is and where it runs over its picture; what it is for, its state and who has it, and what its agent did last. */
function Tile({ screen: p, now }: { screen: PageScreen; now: number }) {
  return (
    <a className={s.tile} href={openHref(p)} data-state={p.x.state}>
      <span className={s.label}>
        <Text size="xs" tone="quiet">
          {p.project.title}
        </Text>
        <Text size="xs" tone="faint">
          {placeLine(p)}
        </Text>
      </span>
      <Thumb screen={p} />
      <span className={s.tileText}>
        <Truncate size="md" expand="none" className={s.purpose}>
          {p.x.purpose}
        </Truncate>
        <Meta screen={p} now={now} project={false} machine={false} />
        <span className={s.doing}>
          <Doing screen={p} />
        </span>
      </span>
    </a>
  );
}

/** How many ended ones Recent shows at first, and how many more each Show more adds. */
export const RECENT_STEP = 12;

/** The ended ones, newest first: the first RECENT_STEP, then RECENT_STEP more at each Show more. */
function Recent({ recent, now }: { recent: readonly PageScreen[]; now: number }) {
  const [shown, setShown] = useState(RECENT_STEP);
  const more = Math.min(RECENT_STEP, recent.length - shown);
  return (
    <div className={s.recent}>
      {recent.slice(0, shown).map((p) => (
        <RecentRow key={p.x.id} screen={p} now={now} />
      ))}
      {more > 0 ? (
        <span className={s.more}>
          <Button variant="quiet" size="sm" onClick={() => setShown((n) => n + RECENT_STEP)}>
            {`Show ${String(more)} more`}
          </Button>
          <Text size="xs" tone="faint" tabular>
            {`${String(shown)} of ${String(recent.length)}`}
          </Text>
        </span>
      ) : null}
    </div>
  );
}

/** An ended one, as a row: what it was for, then how it ended, who, where and when. */
function RecentRow({ screen: p, now }: { screen: PageScreen; now: number }) {
  return (
    <a className={s.recentRow} href={openHref(p)} data-state={p.x.state}>
      <Thumb screen={p} className={s.small} />
      <span className={s.recentText}>
        <Truncate size="md" expand="none" className={s.purposeEnded}>
          {p.x.purpose}
        </Truncate>
        <Meta screen={p} now={now} />
      </span>
    </a>
  );
}

const NONE = {} as const;
const keyOf = (p: { machineId: string; projectId: string }) => `${p.machineId}/${p.projectId}`;

/** The kind in the sentence's words. */
const KIND_PHRASE: Readonly<Record<ScreenKind, string>> = {
  browser: "a browser",
  android: "an Android emulator",
  linux_desktop: "a Linux desktop",
  mac: "the agents’ Mac",
};

/**
 * New screen: one sentence of three picks and Open, under the title (Open a browser on devbox for storefront). The
 * machines are the ones that can host the kind, each with its slots; a full one waits for its next. A kind none can
 * host says why in the sentence's place. Opened, it takes the page with you in control; a wait for a slot, or a screen
 * the hub opens a moment later, shows in its project's Screens tab. Esc or × puts it away.
 */
function OpenLine({ onClose }: { onClose: () => void }) {
  const layer = useDataLayer();
  const projects = useData(selectProjects);
  const owners = useMemo(() => projects ?? [], [projects]);
  const machines = useToolQuery("machine_roles", NONE).data?.machines;
  const [kind, setKind] = useState<ScreenKind>("browser");
  const [owner, setOwner] = useState<string | undefined>(undefined);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const forProject = owners.find((p) => keyOf(p) === owner) ?? owners[0];
  // A project's browser runs on the project's own machine, with its saved sign-ins.
  const home = forProject?.machineId;
  const hosts = hostsFor(machines ?? [], kind, home);
  const host = pickHost(hosts, picked);
  const off = machines === undefined ? null : whyOff(machines, kind, home);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const open = async () => {
    if (busy || host === undefined || forProject === undefined) return;
    setBusy(true);
    const project = { machineId: forProject.machineId, projectId: forProject.projectId };
    const out = await layer.call("screen_open", { projectRef: project, kind, machineId: host.machineId, wait: host.full }, { timeoutMs: 120_000 });
    setBusy(false);
    if (!out.ok) {
      toast({ title: "Couldn’t open the screen", description: out.error.fix === undefined ? out.error.message : `${out.error.message} ${out.error.fix}` });
      return;
    }
    const { session } = out.output;
    if (session !== undefined) {
      // In its list before the view mounts, so the view has it, and watches it, from its first render.
      layer.queryClient.setQueryData<BrowserSessionsOutput>(layer.toolQuery("browser_sessions", { projectRef: project }).queryKey, (old) =>
        old === undefined || old.sessions.some((x) => x.sessionId === session.sessionId) ? old : { ...old, sessions: [session, ...old.sessions] },
      );
    }
    void layer.queryClient.invalidateQueries({ queryKey: ["call", "browser_sessions"] });
    onClose();
    navigate(session === undefined ? panelRoute(project, { tab: "sessions", session: null }) : { id: "screens", open: { project, session: session.sessionId } });
  };

  const hint =
    off !== null
      ? off.why
      : host?.full === true
        ? `${host.name} is full: you’ll have the next free slot.`
        : kind === "mac"
          ? "One at a time: agents wait while you have it."
          : home !== undefined && kind === "browser"
            ? "With its saved sign-ins."
            : "You’re in control from the start.";
  return (
    <div className={s.openLine} role="group" aria-label="New screen">
      <Text size="md">Open</Text>
      <Select<ScreenKind> aria-label="Kind" className={s.pick} value={kind} onValueChange={setKind} options={KINDS.map((k) => ({ value: k.kind, label: KIND_PHRASE[k.kind] }))} />
      {kind === "mac" || hosts.length === 0 ? null : (
        <>
          <Text size="md">on</Text>
          <Select<string>
            aria-label="Machine"
            className={s.pick}
            value={host?.machineId ?? ""}
            onValueChange={setPicked}
            options={hosts.map((h) => ({
              value: h.machineId,
              label: (
                <span className={s.hostOpt}>
                  {h.name}
                  <Text size="xs" tone="faint" tabular>
                    {h.online ? `${String(h.live)} of ${String(h.max)}` : "offline"}
                  </Text>
                </span>
              ),
              textValue: h.name,
            }))}
          />
        </>
      )}
      <Text size="md">for</Text>
      <Select<string> aria-label="For" className={s.pick} value={forProject === undefined ? "" : keyOf(forProject)} onValueChange={setOwner} options={owners.map((p) => ({ value: keyOf(p), label: p.title }))} />
      <span className={s.openHint}>
        <Text size="xs" tone={off === null ? "faint" : "warning"}>
          {hint}
        </Text>
      </span>
      <Button variant="primary" size="sm" disabled={busy || host === undefined || !host.online || forProject === undefined} onClick={() => void open()}>
        {busy ? "Opening…" : host?.full === true ? openWord(host) : "Open"}
      </Button>
      <Button variant="quiet" size="sm" iconOnly icon={<X aria-hidden />} aria-label="Close" onClick={onClose} />
    </div>
  );
}
