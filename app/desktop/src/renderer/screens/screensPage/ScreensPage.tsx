// Screens (D296), a page of its own: every live and recent screen of the projects and Navis you can see. A design
// preview (W399) in three directions, picked with `?design=a|b|c` in the address:
//   A, the wall: what needs you on top, then every live screen as a picture, the ended ones as a list; New screen is
//      one sentence under the title (Open a Browser on devbox for storefront).
//   B, the ledger: Status's columns for screens (what, state, who, for, runs on, time), a small still beside each, and
//      the machines' slots in one strip on top; New screen is a menu of machine and kind, each machine with its slots.
//   C, the console: the list down the left, the open screen live beside it (D278's view, unchanged), ↑ ↓ to move;
//      New screen opens in the view's place.
// A screen opens on the page's own route (#/screens/<machine>/<project>/<id>): in A and B the view takes the page, with
// a way back; in C it is the right side.
import { ChevronDown, MonitorSmartphone, Plus, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, EmptyState, FrameTitle, Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger, Select, StateGlyph, Text, Truncate, cx, toast } from "../../ui";
import { RolePill } from "../agents/parts";
import { agoText } from "../projects/machineText";
import { parseMs } from "../live/format";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { selectProjects } from "../../src/data/selectors";
import { isNavi } from "../navi/model";
import { useNow } from "../live/clock";
import { navigate } from "../shell/navigation";
import type { ProjectKey } from "../shell/routes";
import { SessionView } from "../sessions/SessionView";
import { durationOf, fmtDuration, glyphOf, isLive, STATE_TONE, STATE_WORD } from "../sessions/model";
import { KIND_WORD, split, useScreens, type Kind, type PageScreen } from "./data";
import { Doing, Meta, openHref, openRoute, Thumb } from "./parts";
import s from "./page.module.css";

type Design = "a" | "b" | "c";
const design = ((): Design => {
  const d = new URLSearchParams(location.search).get("design");
  return d === "b" || d === "c" ? d : "a";
})();

export function ScreensPage({ open }: { open: { project: ProjectKey; session: string } | null }) {
  const all = useScreens();
  const now = useNow(all.some((p) => isLive(p.x)));
  if (design === "c") return <Console all={all} open={open} now={now} />;
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
  return design === "b" ? <Ledger all={all} now={now} /> : <Wall all={all} now={now} />;
}

/** The title's quiet line: how many are live, and how many need you. */
const countLine = (all: readonly PageScreen[]): string => {
  const { asking, live } = split(all);
  const n = asking.length + live.length;
  return `${String(n)} live${asking.length === 0 ? "" : ` · ${String(asking.length)} ${asking.length === 1 ? "needs" : "need"} you`}`;
};

function Heading({ title, count, tone = "quiet", children }: { title: string; count: number; tone?: "quiet" | "warning"; children?: ReactNode }) {
  return (
    <h2 className={s.heading}>
      <Text size="xs" tone={tone} strong>
        {title}
      </Text>
      <Text size="xs" tone="faint" tabular>
        {String(count)}
      </Text>
      {children}
    </h2>
  );
}

// ---------------------------------------------------------------------------------------------------------------- A

function Wall({ all, now }: { all: readonly PageScreen[]; now: number }) {
  const { asking, live, recent } = split(all);
  const [composing, setComposing] = useState(false);
  return (
    <div className={s.screen} data-screen="screens.a">
      <FrameTitle title="Screens" detail={countLine(all)}>
        <Button variant="secondary" size="sm" icon={<Plus aria-hidden />} onClick={() => setComposing((c) => !c)} aria-expanded={composing}>
          New screen
        </Button>
      </FrameTitle>
      <div className={s.body}>
        {composing ? <OpenLine onClose={() => setComposing(false)} /> : null}
        {all.length === 0 ? <EmptyState title="No screens yet">When an agent opens a browser, a device or the agents’ Mac, or you open one with New screen, it shows here.</EmptyState> : null}
        {asking.length === 0 ? null : (
          <section aria-label="Needs you">
            <Heading title="Needs you" count={asking.length} tone="warning" />
            {asking.map((p) => (
              <AskingRow key={p.x.id} screen={p} now={now} />
            ))}
          </section>
        )}
        {live.length === 0 ? null : (
          <section aria-label="Live">
            <Heading title="Live" count={live.length} />
            <div className={s.grid}>
              {live.map((p) => (
                <Tile key={p.x.id} screen={p} now={now} />
              ))}
            </div>
          </section>
        )}
        {recent.length === 0 ? null : (
          <section aria-label="Recent">
            <Heading title="Recent" count={recent.length} />
            <div className={s.recent}>
              {recent.map((p) => (
                <RecentRow key={p.x.id} screen={p} now={now} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** One that asks for you: its picture at a size to read, why it asks, and Take over beside it. */
function AskingRow({ screen: p, now }: { screen: PageScreen; now: number }) {
  return (
    <div className={s.asking}>
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
          <Button variant="primary" size="sm" onClick={() => navigate(openRoute(p))}>
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

/** A live one: its picture, what it is for, its state and who has it, and what its agent does now. */
function Tile({ screen: p, now }: { screen: PageScreen; now: number }) {
  return (
    <a className={s.tile} href={openHref(p)} data-state={p.x.state}>
      <span className={s.label}>
        <Text size="xs" tone="quiet">
          {p.project.title}
        </Text>
        <Text size="xs" tone="faint">
          {p.kind === "mac" ? "Agents’ Mac" : `${KIND_WORD[p.kind]} · ${p.machine}`}
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

/** An ended one, as a row: a small still of how it ended, what it was for, then how it ended, who, where and when. */
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

// The machines that can host a screen, with their slots (machine_roles).
const HOST_KIND: Readonly<Record<string, Kind>> = { browser: "browser", android: "android", desktop: "linux_desktop", mac: "mac" };
interface Host {
  readonly id: string;
  readonly kinds: readonly Kind[];
  readonly live: number;
  readonly max: number;
}
const NONE = {} as const;
function useHosts(): readonly Host[] {
  const roles = useToolQuery("machine_roles", NONE).data?.machines;
  return useMemo(
    () =>
      (roles ?? [])
        .map((m) => ({
          id: m.machineId,
          kinds: (m.hosts ?? []).filter((h) => h.ready).flatMap((h) => (HOST_KIND[h.host] === undefined ? [] : [HOST_KIND[h.host] as Kind])),
          live: m.sessionsLive,
          max: m.maxSessions,
        }))
        .filter((m) => m.kinds.length > 0),
    [roles],
  );
}

/** The projects and Navis a screen can be for: Navis first, as in the sidebar. */
function useOwners() {
  const projects = useData(selectProjects);
  return useMemo(() => (projects ?? []).slice().sort((a, b) => Number(isNavi(b)) - Number(isNavi(a))), [projects]);
}
const keyOf = (p: { machineId: string; projectId: string }) => `${p.machineId}/${p.projectId}`;

/** Opens it on the hub; a screen that is yours at once opens in the view, a wait shows in the panel's list. */
function useOpen() {
  const layer = useDataLayer();
  return async (kind: Kind, machineId: string, project: { machineId: string; projectId: string }) => {
    const out = await layer.call("screen_open", { projectRef: { machineId: project.machineId, projectId: project.projectId }, kind, machineId, wait: false });
    if (!out.ok) {
      toast({ title: "Couldn’t open the screen", description: out.error.message });
      return;
    }
    const session = (out.output as { session?: { sessionId: string } }).session;
    if (session !== undefined) navigate({ id: "screens", open: { project, session: session.sessionId } });
  };
}

/** A's New screen: one sentence of three picks and Open, under the title. Esc or × puts it away. */
function OpenLine({ onClose }: { onClose: () => void }) {
  const hosts = useHosts();
  const owners = useOwners();
  const [kind, setKind] = useState<Kind>("browser");
  const fits = hosts.filter((h) => h.kinds.includes(kind));
  const [machine, setMachine] = useState<string | undefined>(undefined);
  const on = fits.find((h) => h.id === machine) ?? fits[0];
  const [owner, setOwner] = useState<string | undefined>(undefined);
  const forProject = owners.find((p) => keyOf(p) === owner) ?? owners.find((p) => p.title === "storefront") ?? owners[0];
  const open = useOpen();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const kinds: Kind[] = ["browser", "android", "linux_desktop", "mac"];
  return (
    <div className={s.openLine} role="group" aria-label="New screen">
      <Text size="md">Open</Text>
      <Select<Kind> aria-label="Kind" className={s.pick} value={kind} onValueChange={setKind} options={kinds.map((k) => ({ value: k, label: k === "mac" ? "the agents’ Mac" : k === "browser" ? "a browser" : k === "android" ? "an Android emulator" : "a Linux desktop" }))} />
      {kind === "mac" ? null : (
        <>
          <Text size="md">on</Text>
          <Select<string>
            aria-label="Machine"
            className={s.pick}
            value={on?.id}
            onValueChange={setMachine}
            options={fits.map((h) => ({ value: h.id, label: <span className={s.hostOpt}>{h.id}<Text size="xs" tone="faint" tabular>{`${String(h.live)} of ${String(h.max)}`}</Text></span>, textValue: h.id }))}
          />
        </>
      )}
      <Text size="md">for</Text>
      <Select<string> aria-label="For" className={s.pick} value={forProject === undefined ? undefined : keyOf(forProject)} onValueChange={setOwner} options={owners.map((p) => ({ value: keyOf(p), label: p.title }))} />
      <span className={s.openHint}>
        <Text size="xs" tone="faint">
          {kind === "mac" ? "One at a time: agents wait while you have it." : forProject !== undefined && isNavi(forProject) ? "With its saved sign-ins." : "You’re in control from the start."}
        </Text>
      </span>
      <Button variant="primary" size="sm" disabled={on === undefined || forProject === undefined} onClick={() => on !== undefined && forProject !== undefined && void open(kind, on.id, forProject)}>
        Open
      </Button>
      <Button variant="quiet" size="sm" iconOnly icon={<X aria-hidden />} aria-label="Close" onClick={onClose} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- B

/** B, the ledger: Status's columns for screens, a still beside each; the machines and their slots in one strip on top. */
function Ledger({ all, now }: { all: readonly PageScreen[]; now: number }) {
  const { asking, live, recent } = split(all);
  const hosts = useHosts();
  const groups: Array<[string, readonly PageScreen[], "quiet" | "warning"]> = [
    ["Needs you", asking, "warning"],
    ["Live", live, "quiet"],
    ["Recent", recent, "quiet"],
  ];
  return (
    <div className={s.screen} data-screen="screens.b">
      <FrameTitle title="Screens" detail={countLine(all)}>
        <OpenMenu hosts={hosts} />
      </FrameTitle>
      <div className={s.body}>
        <div className={s.strip} aria-label="Machines">
          {hosts.map((h) => (
            <span key={h.id} className={s.stripHost}>
              <Text size="xs" strong={false}>
                {h.id === "mac" ? "Agents’ Mac" : h.id}
              </Text>
              {h.id === "mac" ? (
                <Text size="xs" tone="quiet">
                  {h.live >= h.max ? "in use, one at a time" : "free"}
                </Text>
              ) : (
                <Slots live={h.live} max={h.max} />
              )}
            </span>
          ))}
        </div>
        <div className={s.ledger} role="table" aria-label="Screens">
          <div className={s.columns} role="row">
            {["", "Screen", "State", "Who", "For", "Runs on", ""].map((c, i) => (
              <span key={i} role="columnheader">
                <Text size="xs" tone="quiet">
                  {c}
                </Text>
              </span>
            ))}
          </div>
          {groups.map(([title, list, tone]) =>
            list.length === 0 ? null : (
              <div key={title} role="rowgroup" aria-label={title} className={s.ledgerGroup}>
                <span className={s.ledgerHeading}>
                  <Text size="xs" tone={tone} strong>
                    {title}
                  </Text>
                  <Text size="xs" tone="faint" tabular>
                    {String(list.length)}
                  </Text>
                </span>
                {list.map((p) => (
                  <LedgerRow key={p.x.id} screen={p} now={now} />
                ))}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function LedgerRow({ screen: p, now }: { screen: PageScreen; now: number }) {
  const x = p.x;
  const ended = parseMs(x.endedAt);
  const mine = x.openedBy !== undefined;
  return (
    <a className={cx(s.ledgerRow, !isLive(x) && s.ledgerEnded)} href={openHref(p)} role="row" data-state={x.state}>
      <Thumb screen={p} className={s.mini} />
      <span className={s.cellMain} role="cell">
        <Truncate size="md" expand="none" className={isLive(x) ? s.purpose : s.purposeEnded}>
          {x.purpose}
        </Truncate>
        <span className={s.doing}>
          <Doing screen={p} />
        </span>
      </span>
      <span className={s.state} role="cell">
        <StateGlyph state={glyphOf(x.state)} label={STATE_WORD[x.state]} phase={x.id.length % 4} />
        <Text size="xs" tone={STATE_TONE[x.state]} strong={x.state === "asking" || x.state === "yours"}>
          {STATE_WORD[x.state]}
        </Text>
      </span>
      <span className={s.cell} role="cell">
        {mine ? (
          <Text size="xs" tone="quiet">
            {x.state === "yours" ? "You" : x.openedBy}
          </Text>
        ) : p.project.navi ? (
          <Text size="xs" tone="quiet">
            Navi
          </Text>
        ) : x.agent.role === undefined ? (
          <Truncate size="xs" tone="quiet" expand="none">
            {x.agent.title}
          </Truncate>
        ) : (
          <span className={s.who}>
            <RolePill role={x.agent.role} />
            <Truncate size="xs" tone="quiet" expand="none">
              {x.agent.title}
            </Truncate>
          </span>
        )}
      </span>
      <span className={s.cell} role="cell">
        <Text size="xs" tone="quiet">
          {p.project.title}
        </Text>
      </span>
      <span className={s.cell} role="cell">
        <Text size="xs" tone="quiet">
          {p.kind === "mac" ? "Agents’ Mac" : `${KIND_WORD[p.kind]} · ${p.machine}`}
        </Text>
      </span>
      <span className={s.cellEnd} role="cell">
        {x.state === "asking" ? (
          <Button variant="primary" size="sm" tabIndex={-1}>
            Take over
          </Button>
        ) : (
          <Text size="xs" tone="faint" tabular>
            {ended === undefined ? fmtDuration(durationOf(x, now)) : agoText(now - ended)}
          </Text>
        )}
      </span>
    </a>
  );
}

/** A machine's slots as a row of cells, lit while in use: the state glyph's dither cell, at rest. */
function Slots({ live, max }: { live: number; max: number }) {
  return (
    <span className={s.slots} aria-label={`${String(live)} of ${String(max)} screens in use`}>
      <span className={s.cells} aria-hidden>
        {Array.from({ length: max }, (_, i) => (
          <i key={i} data-on={i < live} />
        ))}
      </span>
      <Text size="xs" tone="quiet" tabular>
        {`${String(live)} of ${String(max)}`}
      </Text>
    </span>
  );
}

/** B's New screen: a menu of where and what, each machine with its slots, and who it is for. */
function OpenMenu({ hosts }: { hosts: readonly Host[] }) {
  const owners = useOwners();
  const [owner, setOwner] = useState<string>(() => keyOf(owners.find((p) => p.title === "storefront") ?? owners[0] ?? { machineId: "", projectId: "" }));
  const open = useOpen();
  const target = owners.find((p) => keyOf(p) === owner);
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="secondary" size="sm" icon={<Plus aria-hidden />}>
          New screen
          <ChevronDown aria-hidden className={s.chev} />
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        {hosts.map((h, i) => (
          <div key={h.id}>
            {i === 0 ? null : <MenuSeparator />}
            <div className={s.menuHost}>
              <Text size="xs" tone="quiet" strong>
                {h.id === "mac" ? "Agents’ Mac" : h.id}
              </Text>
              <Text size="xs" tone="faint" tabular>
                {h.id === "mac" ? (h.live >= h.max ? "in use" : "free") : `${String(h.live)} of ${String(h.max)}`}
              </Text>
            </div>
            {h.kinds.map((k) => (
              <MenuItem key={k} onSelect={() => target !== undefined && void open(k, h.id, target)}>
                {k === "mac" ? (h.live >= h.max ? "Wait for the Mac" : "Open the Mac") : h.live >= h.max ? `${KIND_WORD[k]}, next free slot` : KIND_WORD[k]}
              </MenuItem>
            ))}
          </div>
        ))}
        <MenuSeparator />
        <MenuRadioGroup value={owner} onValueChange={setOwner}>
          {owners.map((p) => (
            <MenuRadioItem key={keyOf(p)} value={keyOf(p)}>
              {`For ${p.title}`}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

// ---------------------------------------------------------------------------------------------------------------- C

function Console({ all, open, now }: { all: readonly PageScreen[]; open: { project: ProjectKey; session: string } | null; now: number }) {
  const { asking, live, recent } = split(all);
  const order = useMemo(() => [...asking, ...live, ...recent], [asking, live, recent]);
  const [composing, setComposing] = useState(false);
  // With none open, the first that needs you, else the first live one.
  const current = open === null ? order[0] : order.find((p) => p.x.id === open.session);
  useEffect(() => {
    const step = (e: KeyboardEvent) => {
      if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.target instanceof HTMLInputElement) return;
      const at = order.findIndex((p) => p.x.id === current?.x.id);
      const next = order[Math.min(order.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next !== undefined) {
        e.preventDefault();
        setComposing(false);
        navigate(openRoute(next));
      }
    };
    window.addEventListener("keydown", step);
    return () => window.removeEventListener("keydown", step);
  }, [order, current]);
  const groups: Array<[string, readonly PageScreen[], "quiet" | "warning"]> = [
    ["Needs you", asking, "warning"],
    ["Live", live, "quiet"],
    ["Recent", recent, "quiet"],
  ];
  return (
    <div className={s.screen} data-screen="screens.c">
      <FrameTitle title="Screens" detail={countLine(all)} />
      <div className={s.console}>
        <nav className={s.side} aria-label="Screens">
          <button type="button" className={cx(s.newRow, composing && s.current)} onClick={() => setComposing(true)}>
            <Plus aria-hidden className={s.newIcon} />
            <Text size="md">New screen</Text>
          </button>
          {groups.map(([title, list, tone]) =>
            list.length === 0 ? null : (
              <section key={title} aria-label={title}>
                <Heading title={title} count={list.length} tone={tone} />
                {list.map((p) => (
                  <a key={p.x.id} className={cx(s.sideRow, !composing && current?.x.id === p.x.id && s.current, !isLive(p.x) && s.sideEnded)} href={openHref(p)} onClick={() => setComposing(false)} data-state={p.x.state}>
                    <Thumb screen={p} className={s.mini} />
                    <span className={s.sideText}>
                      <Truncate size="md" expand="none" className={isLive(p.x) ? s.purpose : s.purposeEnded}>
                        {p.x.purpose}
                      </Truncate>
                      <Meta screen={p} now={now} machine={false} />
                    </span>
                  </a>
                ))}
              </section>
            ),
          )}
        </nav>
        <div className={s.detail}>
          {composing ? (
            <NewPane onClose={() => setComposing(false)} />
          ) : current === undefined ? (
            <EmptyState title="No screens yet">When an agent opens a browser, a device or the agents’ Mac, or you open one with New screen, it shows here.</EmptyState>
          ) : (
            <SessionView key={current.x.id} project={current.x.projectRef} id={current.x.id} onBack={null} />
          )}
        </div>
      </div>
    </div>
  );
}

/** C's New screen, in the view's place: the kind, the machine with its slots, who it is for, then Open. */
function NewPane({ onClose }: { onClose: () => void }) {
  const hosts = useHosts();
  const owners = useOwners();
  const [kind, setKind] = useState<Kind>("browser");
  const fits = hosts.filter((h) => h.kinds.includes(kind));
  const [machine, setMachine] = useState<string | undefined>(undefined);
  const on = fits.find((h) => h.id === machine) ?? fits[0];
  const [owner, setOwner] = useState<string | undefined>(undefined);
  const forProject = owners.find((p) => keyOf(p) === owner) ?? owners.find((p) => p.title === "storefront") ?? owners[0];
  const open = useOpen();
  const kinds: Kind[] = ["browser", "android", "linux_desktop", "mac"];
  const LINE: Readonly<Record<Kind, string>> = {
    browser: "A fresh Chrome; a Navi’s keeps its sign-ins",
    android: "An emulator, with a PR’s build if you pick one",
    linux_desktop: "A desktop with a terminal",
    mac: "The Mac agents share, one at a time",
    ios: "",
  };
  return (
    <div className={s.newPane} role="group" aria-label="New screen">
      <div className={s.newHead}>
        <Text size="md" strong>
          New screen
        </Text>
        <Text size="xs" tone="quiet">
          Yours from the start, recorded like an agent’s, and ended when you close it or it sits idle.
        </Text>
        <span className={s.gap} />
        <Button variant="quiet" size="sm" iconOnly icon={<X aria-hidden />} aria-label="Close" onClick={onClose} />
      </div>
      <div className={s.newBody}>
        <div className={s.field}>
          <Text size="xs" tone="quiet" strong>
            Kind
          </Text>
          <div className={s.kinds} role="radiogroup" aria-label="Kind">
            {kinds.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={k === kind} className={cx(s.kind, k === kind && s.kindOn)} onClick={() => setKind(k)}>
                <Text size="md" strong={k === kind}>
                  {KIND_WORD[k]}
                </Text>
                <Text size="xs" tone="quiet">
                  {LINE[k]}
                </Text>
              </button>
            ))}
          </div>
        </div>
        <div className={s.field}>
          <Text size="xs" tone="quiet" strong>
            On
          </Text>
          <div className={s.hosts} role="radiogroup" aria-label="Machine">
            {fits.map((h) => (
              <button key={h.id} type="button" role="radio" aria-checked={h.id === on?.id} className={cx(s.host, h.id === on?.id && s.kindOn)} onClick={() => setMachine(h.id)}>
                <Text size="md" strong={h.id === on?.id}>
                  {h.id === "mac" ? "Agents’ Mac" : h.id}
                </Text>
                <Slots live={h.live} max={h.max} />
              </button>
            ))}
          </div>
        </div>
        <div className={s.field}>
          <Text size="xs" tone="quiet" strong>
            For
          </Text>
          <Select<string> aria-label="For" className={s.pickWide} value={forProject === undefined ? undefined : keyOf(forProject)} onValueChange={setOwner} options={owners.map((p) => ({ value: keyOf(p), label: isNavi(p) ? `${p.title} (Navi)` : p.title, textValue: p.title }))} />
        </div>
        <div className={s.newFoot}>
          <Button variant="primary" size="md" icon={<MonitorSmartphone aria-hidden />} disabled={on === undefined || forProject === undefined} onClick={() => on !== undefined && forProject !== undefined && void open(kind, on.id, forProject)}>
            {on !== undefined && on.live >= on.max ? "Wait for a slot" : "Open screen"}
          </Button>
        </div>
      </div>
    </div>
  );
}
