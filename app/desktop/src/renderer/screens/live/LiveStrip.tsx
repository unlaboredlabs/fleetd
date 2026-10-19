// The live strip under the lead's latest message: "3 agents working", one quiet line each (role, what it's doing,
// its PR), unfolding to the lanes grouped by PR and a link to the time view. Nothing is drawn when nothing runs.
// Folded, it redraws only when a line's words change; unfolded, its clocks tick once a second while agents run.
import { ChevronRight } from "lucide-react";
import { useId, useSyncExternalStore, type CSSProperties } from "react";
import { useData } from "../../src/data/react";
import { selectBoardData } from "../../src/data/selectors";
import { Button, RoleTag, Text, Truncate, cx, roleTint, toast } from "../../ui";
import { useNow } from "./clock";
import type { AgentLane } from "./contracts";
import { groupLabel, reviewProgress, writtenIn } from "./fleet";
import { hubNow, projectKey } from "./lanes";
import { Check, LaneRow, MiddleCut, Track } from "./parts";
import { isRunning, stageTone } from "./words";
import { FOLDED_LINES, type ProjectRef, type StripLine, projectFleet, selectStrip, stripHeadline } from "./strip";
import s from "./live.module.css";

const openPr = (url: string) => {
  void window.fleetd.openExternal(url).then((o) => {
    if (!o.ok) toast({ title: "Couldn't open the PR", description: o.message, tone: "danger" });
  });
};

const TONE: Record<StripLine["tone"], string | undefined> = {
  quiet: s.quiet,
  loud: s.loud,
  warning: s.warning,
  danger: s.danger,
  success: s.success,
};

export interface LiveStripProps {
  readonly project: ProjectRef;
  /** "What it was told": the chat opens that agent's prompt. */
  readonly onTold?: ((lane: AgentLane) => void) | undefined;
}

// Whether each project's strip is unfolded, kept outside the component: the chat's virtual list remounts its rows
// (a resize, a scroll away and back), and an unfolded strip must stay unfolded.
const unfolded = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const setUnfolded = (key: string, open: boolean) => {
  if (open) unfolded.add(key);
  else unfolded.delete(key);
  for (const l of listeners) l();
};

export function LiveStrip({ project, onTold }: LiveStripProps) {
  const strip = useData(selectStrip(project));
  const key = projectKey(project);
  const open = useSyncExternalStore(subscribe, () => unfolded.has(key));
  const setOpen = (next: boolean) => setUnfolded(key, next);
  const body = useId();
  if (strip === undefined || strip.lines.length === 0) return null;
  const headline = stripHeadline(strip);
  const shown = strip.lines.slice(0, FOLDED_LINES);
  const more = strip.lines.length - shown.length;
  return (
    <section className={s.strip} aria-label={headline} data-live-strip={open ? "open" : "folded"}>
      <button type="button" className={s.head} aria-expanded={open} aria-controls={body} onClick={() => setOpen(!open)}>
        <ChevronRight className={cx(s.chevron, open && s.chevronOpen)} aria-hidden />
        <Truncate expand="none" size="sm" tone="inherit">
          {headline}
        </Truncate>
      </button>
      <div id={body}>
        {open ? (
          <Lanes project={project} onTold={onTold} />
        ) : (
          <ul className={s.lines}>
            {shown.map((l) => (
              <li key={l.laneId} className={s.line} style={{ "--tint": roleTint(l.role) } as CSSProperties}>
                <span className={s.edge} aria-hidden />
                <RoleTag role={l.role} width={84}>
                  {l.roleWord}
                </RoleTag>
                <span className={cx(s.doing, TONE[l.tone])}>
                  <span className={s.words}>{l.words}</span>
                  {l.machine !== undefined ? <MiddleCut text={l.machine} /> : null}
                </span>
                {l.pr ? <PrLink pr={l.pr} /> : null}
              </li>
            ))}
            {more > 0 ? (
              <li className={s.more}>
                <Button variant="quiet" onClick={() => setOpen(true)}>
                  {`+${more} more`}
                </Button>
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </section>
  );
}

function PrLink({ pr }: { pr: NonNullable<StripLine["pr"]> }) {
  return (
    <button type="button" className={s.pr} onClick={() => openPr(pr.url)} aria-label={`Open PR #${pr.number} on GitHub`}>
      <span className={s.prNumber}>#{pr.number}</span>
      {pr.label !== "" ? <span className={s.prLabel}>{pr.label}</span> : null}
    </button>
  );
}

/** Unfolded: the agents as lanes, writers first, then each PR with its checkers; and where the time went. */
function Lanes({ project, onTold }: LiveStripProps) {
  const d = useData(selectBoardData);
  const { lanes, fleet: f } = projectFleet(d, project);
  const orders = (d.orders ?? []).filter((o) => projectKey(o.card.projectRef) === projectKey(project));
  const now = hubNow(d, useNow(lanes.some((l) => isRunning(l.status))));
  const row = (l: AgentLane, indent: boolean) => (
    <div key={l.laneId} className={cx(indent && s.indent)}>
      <LaneRow lane={l} density="card" now={now} stale={d.stale} {...(onTold ? { onOpen: onTold } : {})} />
    </div>
  );
  const one = orders.length === 1 ? orders[0] : undefined;
  return (
    <div className={s.lanes}>
      {f.writers.map((l) => row(l, false))}
      {f.groups
        .filter((g) => g.rows.length > 0 || lanes.some((l) => l.laneId === g.writer?.laneId))
        .map((g) => {
          const written = writtenIn(g);
          const writer = g.writer && lanes.find((l) => l.laneId === g.writer?.laneId);
          return (
            <div key={g.pr.changeId}>
              <div className={s.group}>
                <span className={s.prNumber}>#{g.pr.number}</span>
                {g.writer ? (
                  <Truncate expand="none" size="sm">
                    {g.writer.title}
                  </Truncate>
                ) : null}
                <Track state={g.pr.state} review={reviewProgress(g)} />
                <span className={cx(s.groupLabel, stageTone(g.pr.state) === "success" ? s.success : s.quiet)}>{groupLabel(g)}</span>
                {written ? (
                  <span className={s.written}>
                    <Check />
                    {written}
                  </span>
                ) : null}
              </div>
              {writer ? row(writer, true) : null}
              {g.rows.map((l) => row(l, true))}
            </div>
          );
        })}
      {f.others.map((l) => row(l, false))}
      <div className={s.foot}>
        <a className={s.timeLink} href={one ? `#/time/order/${encodeURIComponent(one.card.workstreamId)}` : "#/time"}>
          <Text size="xs" tone="inherit">
            Where the time went
          </Text>
        </a>
      </div>
    </div>
  );
}
