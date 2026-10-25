// The live strip, docked to the top of the lead chat's composer: one slim row, a dot per agent (at work they breathe,
// waiting on you they take the attention color, queued they are hollow), "3 agents working · 1 needs you" in a quiet
// voice, and a now-line saying what the busiest agent is doing. Hovering or clicking the row opens the lanes above
// it, one row per agent; an agent (its row, or the now-line) opens in the panel's agents, where its live work and
// steer box are. Nothing is drawn when no agent is shown.
import { ChevronUp } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useData } from "../../src/data/react";
import { RoleTag, Text, Truncate, cx, roleTint } from "../../ui";
import { panelRoute, toHash } from "../shell/routes";
import { useNow } from "./clock";
import { ActivityLine } from "./parts";
import { NOW_DWELL_MS, type ProjectRef, type Strip, type StripAgent, nowAgent, selectStrip, stripHeadline, stripPrs } from "./strip";
import s from "./live.module.css";

/** Dots past this many are a count: twenty dots say no more than twelve and a "+8". */
const MAX_DOTS = 12;
/** Hovering opens the lanes after this long, so passing over the strip on the way to the box doesn't. */
const HOVER_OPEN_MS = 350;
const HOVER_CLOSE_MS = 250;

const agentHref = (project: ProjectRef, laneId: string | null): string => toHash(panelRoute(project, { tab: "agents", agent: laneId }));

export function LiveStrip({ project }: { project: ProjectRef }) {
  const strip = useData(selectStrip(project));
  if (strip === undefined || strip.agents === 0) return null;
  return <Dock project={project} strip={strip} />;
}

/** Closed, opened by the pointer resting on it (it closes as the pointer leaves), or opened by a click (it stays). */
type Open = "closed" | "hover" | "pinned";

function Dock({ project, strip }: { project: ProjectRef; strip: Strip }) {
  const headline = stripHeadline(strip);
  const lanesId = useId();
  const [open, setOpen] = useState<Open>("closed");
  const timer = useRef<number | undefined>(undefined);
  const later = (next: Open, ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen((o) => (o === "pinned" ? o : next)), ms);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const close = () => {
    window.clearTimeout(timer.current);
    setOpen("closed");
  };
  return (
    <section
      className={s.dock}
      aria-label={headline}
      data-open={open === "closed" ? undefined : open}
      onPointerEnter={(e) => e.pointerType === "mouse" && later("hover", HOVER_OPEN_MS)}
      onPointerLeave={(e) => e.pointerType === "mouse" && later("closed", HOVER_CLOSE_MS)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open !== "closed") {
          e.stopPropagation();
          close();
        }
      }}
    >
      {open === "closed" ? null : <Lanes id={lanesId} project={project} strip={strip} onOpened={close} />}
      <div className={s.strip}>
        <button
          type="button"
          className={s.toggle}
          aria-expanded={open !== "closed"}
          aria-controls={open === "closed" ? undefined : lanesId}
          onClick={() => {
            window.clearTimeout(timer.current);
            setOpen((o) => (o === "pinned" ? "closed" : "pinned"));
          }}
        >
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
    </section>
  );
}

function Dots({ lanes }: { lanes: readonly StripAgent[] }) {
  const more = lanes.length - MAX_DOTS;
  return (
    <span className={s.dots} aria-hidden>
      {lanes.slice(0, MAX_DOTS).map((a, i) => (
        <span
          key={a.laneId}
          className={cx(s.dot, s[a.state])}
          // At work, a dot takes its role's tint, and breathes a little out of step with its neighbours.
          style={a.state === "working" ? { color: roleTint(a.role), animationDelay: `${-((i * 700) % 2800)}ms` } : undefined}
        />
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
