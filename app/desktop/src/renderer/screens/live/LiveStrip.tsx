// The live strip, docked to the top of the lead chat's composer: one slim row, a dot per agent (at work in their
// role's tint, waiting on you in the attention color, queued hollow; each pulses once as it appears or changes, then
// holds still), "3 agents working · 1 needs you" in a quiet
// voice, and a now-line saying what the busiest agent is doing. A click on the row (or Enter on it) opens the lanes
// above it, one row per agent, and a second click, a press outside it or Escape closes them; an agent (its row, or
// the now-line) opens in the panel's agents, where its live work and steer box are. Nothing is drawn when no agent is
// shown.
import { ChevronUp } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { useData } from "../../src/data/react";
import { RoleTag, StateGlyph, Text, Truncate, cx, roleTint, type GlyphState } from "../../ui";
import { panelRoute, toHash } from "../shell/routes";
import { useNow } from "./clock";
import { ActivityLine } from "./parts";
import { NOW_DWELL_MS, type ProjectRef, type Strip, type StripAgent, nowAgent, selectStrip, stripHeadline, stripPrs } from "./strip";
import s from "./live.module.css";

/** Dots past this many are a count: twenty dots say no more than twelve and a "+8". */
const MAX_DOTS = 12;

const agentHref = (project: ProjectRef, laneId: string | null): string => toHash(panelRoute(project, { tab: "agents", agent: laneId }));

export function LiveStrip({ project }: { project: ProjectRef }) {
  const strip = useData(selectStrip(project));
  if (strip === undefined || strip.agents === 0) return null;
  return <Dock project={project} strip={strip} />;
}

function Dock({ project, strip }: { project: ProjectRef; strip: Strip }) {
  const headline = stripHeadline(strip);
  const lanesId = useId();
  const [open, setOpen] = useState(false);
  const dock = useRef<HTMLElement>(null);
  // Open, a press anywhere outside the strip closes it.
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !dock.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const close = () => setOpen(false);
  return (
    <section
      ref={dock}
      className={s.dock}
      aria-label={headline}
      data-open={open ? "" : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      {/* The row comes first, so Tab goes from the toggle to the lanes; the tray draws the lanes above it. */}
      <div className={s.strip}>
        <button type="button" className={s.toggle} aria-expanded={open} aria-controls={open ? lanesId : undefined} onClick={() => setOpen((o) => !o)}>
          <Dots lanes={strip.lanes} />
          <span className={s.headline}>
            <Truncate expand="none" size="xs" tone="inherit">
              {headline}
            </Truncate>
          </span>
        </button>
        <NowLine project={project} strip={strip} />
        <ChevronUp className={s.chevron} size={14} aria-hidden />
      </div>
      {open ? <Lanes id={lanesId} project={project} strip={strip} onOpened={close} /> : null}
    </section>
  );
}

const GLYPH: Readonly<Record<StripAgent["state"], GlyphState>> = { working: "working", needsYou: "waiting", onHold: "paused", queued: "queued" };

/** A glyph per agent (StateGlyph), each a little out of step with the next so a row of them never beats as one. */
function Dots({ lanes }: { lanes: readonly StripAgent[] }) {
  const more = lanes.length - MAX_DOTS;
  return (
    <span className={s.dots} aria-hidden>
      {lanes.slice(0, MAX_DOTS).map((a, i) => (
        <span key={a.laneId} className={s.glyph} style={{ "--glyph-phase": (i * 0.37) % 1 } as CSSProperties}>
          <StateGlyph state={a.state === "working" && a.line.thinking ? "thinking" : GLYPH[a.state]} size="sm" />
        </span>
      ))}
      {more > 0 ? <span className={s.more}>+{more}</span> : null}
    </span>
  );
}

/**
 * What the busiest agent is doing, a link to it in the panel. A new line rolls in from below; one agent stays on it
 * a few seconds before a busier one takes it (strip.ts nowAgent).
 */
function NowLine({ project, strip }: { project: ProjectRef; strip: Strip }) {
  // The clock only ticks while there is someone to turn to.
  const at = useNow(strip.now.length > 1, NOW_DWELL_MS);
  const [shown, setShown] = useState<{ laneId: string; since: number }>();
  const pick = nowAgent(strip.now, shown, at);
  if (pick !== shown?.laneId) setShown(pick === undefined ? undefined : { laneId: pick, since: at });
  const agent = strip.lanes.find((a) => a.laneId === pick);
  if (agent === undefined) return <span className={s.now} />;
  const { line } = agent;
  return (
    <a className={s.now} href={agentHref(project, agent.laneId)}>
      <span key={`${agent.laneId}\n${line.words}\n${line.machine ?? ""}`} className={s.roll}>
        <RoleTag role={agent.role} inRow />
        <ActivityLine line={line} />
      </span>
    </a>
  );
}

/** The lanes, opened above the row: the PRs the agents are on, a way to the panel's list, and a row per agent. */
function Lanes({ id, project, strip, onOpened }: { id: string; project: ProjectRef; strip: Strip; onOpened: () => void }) {
  const prs = stripPrs(strip.prs);
  return (
    <div id={id} className={s.lanes}>
      <div className={s.lanesHead}>
        <Text size="xs" tone="quiet">
          {prs.length === 0
            ? "Agents"
            : prs.map((part, i) => {
                if (typeof part === "string") return part;
                const href = toHash(panelRoute(project, { tab: "prs", pr: { repo: null, number: part } }));
                return (
                  <a key={i} className={s.pr} href={href} onClick={onOpened}>
                    #{part}
                  </a>
                );
              })}
        </Text>
        <a className={s.all} href={agentHref(project, null)} onClick={onOpened}>
          <Text size="xs" tone="inherit">
            Open in the panel
          </Text>
        </a>
      </div>
      <ul className={s.list} aria-label="Agents at work">
        {strip.lanes.map((a) => (
          <li key={a.laneId}>
            <a className={s.lane} href={agentHref(project, a.laneId)} onClick={onOpened}>
              <span className={cx(s.dot, s[a.state])} style={a.state === "working" ? { color: roleTint(a.role) } : undefined} aria-hidden />
              <RoleTag role={a.role} width={64} inRow />
              <span className={s.title}>
                <Truncate expand="none" size="sm" tone="inherit">
                  {a.title}
                </Truncate>
              </span>
              <ActivityLine line={a.line} />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
