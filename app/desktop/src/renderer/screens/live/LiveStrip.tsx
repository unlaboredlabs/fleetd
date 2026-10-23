// The live strip after the lead's latest message (and after the field that answers it): folded, one line, "5 agents
// working" and the PRs they are on. Opened, one line per PR and per agent (its role, what it's doing, for how long),
// in a box that stops at about a third of the window and scrolls, drawing only the rows in view, and a link to the
// time view, where the model, tokens and activity live. Nothing is drawn when no agent is shown.
import { ChevronRight } from "lucide-react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useEffect, useId, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { useData, useToolQuery } from "../../src/data/react";
import { Text, Truncate, VirtualList, cx } from "../../ui";
import { navigate } from "../shell/navigation";
import { runCommand } from "../palette";
import { useNow, useOnScreen } from "./clock";
import type { AgentLane } from "./contracts";
import { projectKey } from "./lanes";
import { AgentLine } from "./parts";
import { isRunning } from "./words";
import { type ProjectRef, type Strip, type StripRow, selectSkew, selectStrip, stripHeadline, stripPrs } from "./strip";
import s from "./live.module.css";

const TONE: Partial<Record<StripRow["tone"], string | undefined>> = {
  warning: s.warning,
  danger: s.danger,
  success: s.success,
};

/** The composer's command: it scrolls to what the lead is waiting on and focuses it (chat/Composer). */
const SHOW_WAITING = "chat.showWaiting";

export interface LiveStripProps {
  readonly project: ProjectRef;
  /** "What it was told": the chat opens that agent's prompt. */
  readonly onTold?: ((lane: AgentLane) => void) | undefined;
}

// Whether each project's strip is open, kept outside the component: the chat's virtual list remounts its rows (a
// resize, a scroll away and back), and an open strip must stay open.
const unfolded = new Set<string>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const setUnfolded = (key: string, open: boolean) => {
  if (open) unfolded.add(key);
  else unfolded.delete(key);
  reveal = open ? key : undefined;
  for (const l of listeners) l();
};
// The same remounts would reset the opened box's scroll, so it is kept here too; and a strip just opened by a click
// is brought into view once, so its rows don't open below the bottom of the chat.
const scrolled = new Map<string, number>();
let reveal: string | undefined;

export function LiveStrip({ project, onTold }: LiveStripProps) {
  const strip = useData(selectStrip(project));
  const key = projectKey(project);
  const open = useSyncExternalStore(subscribe, () => unfolded.has(key));
  const body = useId();
  if (strip === undefined || strip.rows.length === 0) return null;
  const headline = stripHeadline(strip);
  const prs = stripPrs(strip.prs);
  return (
    <section className={s.strip} aria-label={headline} data-live-strip={open ? "open" : "folded"}>
      <button type="button" className={s.head} aria-expanded={open} aria-controls={body} onClick={() => setUnfolded(key, !open)}>
        <ChevronRight className={cx(s.chevron, open && s.chevronOpen)} aria-hidden />
        <span className={s.headline}>
          <Truncate expand="none" size="sm" tone="inherit">
            {headline}
          </Truncate>
        </span>
        {!open && prs !== "" ? (
          <span className={s.prs}>
            <Truncate expand="none" size="xs" tone="quiet">
              {prs}
            </Truncate>
          </span>
        ) : null}
      </button>
      {open ? <Opened id={body} project={project} strip={strip} onTold={onTold} /> : <div id={body} hidden />}
    </section>
  );
}

/**
 * Loads an order's detail while the strip is open: the agents its card leaves out (writers that finished, done
 * reviews), so a PR's line can name what it's for and count its reviews. Draws nothing.
 */
function OrderDetail({ workstreamId }: { workstreamId: string }) {
  useToolQuery("order_get", { workstreamId });
  return null;
}

/** Row heights, px, as lanes.module.css draws them: the box is sized to its rows up to a third of the window. */
const ROW_PX = { agent: 24, pr: 28 } as const;

function Opened({ id, project, strip, onTold }: { id: string; project: ProjectRef; strip: Strip; onTold: LiveStripProps["onTold"] }) {
  const key = projectKey(project);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<Virtualizer<HTMLDivElement, Element> | null>(null);
  // An effect, not a layout effect: the list hands over its virtualizer in its own effect, which runs first.
  useEffect(() => {
    const top = scrolled.get(key);
    if (top !== undefined) list.current?.scrollToOffset(top);
    if (reveal !== key) return;
    // Opened by a click: an agent waiting on you is in view, even when it is below the box's fold.
    const waiting = strip.rows.findIndex((r) => r.kind === "agent" && r.lane.status === "waiting");
    if (waiting !== -1) list.current?.scrollToIndex(waiting, { align: "auto" });
    // A frame later, once the chat's list has measured the strip's new height.
    const frame = requestAnimationFrame(() => {
      reveal = undefined;
      box.current?.closest("section")?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
    // Only on mount: later frames must not move the box under the reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const onScreen = useOnScreen(box);
  const running = strip.rows.some((r) => r.kind === "agent" && isRunning(r.lane.status));
  const now = useNow(running && onScreen) + useData(selectSkew);
  const height = strip.rows.reduce((h, r) => h + ROW_PX[r.kind], 0);
  const one = strip.orders.length === 1 ? strip.orders[0] : undefined;
  const render = (r: StripRow) => {
    if (r.kind === "pr") {
      return (
        <div className={s.group}>
          {/* The PR view keeps Open on GitHub one click away. */}
          <button type="button" className={s.pr} onClick={() => navigate({ id: "prs", project, pr: { repo: null, number: r.number } })} aria-label={`Open PR #${r.number}`}>
            #{r.number}
          </button>
          <span className={s.groupTitle}>
            <Truncate expand="none" size="sm" tone={r.title === undefined ? "quiet" : "default"}>
              {r.title ?? "pull request"}
            </Truncate>
          </span>
          <span className={cx(s.groupLabel, TONE[r.tone] ?? s.quiet)}>{r.label}</span>
        </div>
      );
    }
    const lane = r.lane;
    const told = onTold && lane.threadRef ? () => onTold(lane) : undefined;
    // Waiting on you: jump to the field it waits on; with no such command running, show what it was told.
    const onOpen =
      lane.status === "waiting"
        ? () => {
            if (!runCommand(SHOW_WAITING)) told?.();
          }
        : told;
    return <AgentLine row={r} now={now} stale={strip.stale} onOpen={onOpen} />;
  };
  return (
    <div id={id} className={s.opened} ref={box}>
      {strip.orders.map((w) => (
        <OrderDetail key={w} workstreamId={w} />
      ))}
      <div
        className={s.rows}
        style={{ "--rows-px": `${height}px` } as CSSProperties}
        onScrollCapture={(e) => scrolled.set(key, (e.target as HTMLElement).scrollTop)}
      >
        <VirtualList items={strip.rows} getKey={(r) => r.key} renderItem={render} estimateSize={ROW_PX.agent} virtualizerRef={list} aria-label="Agents" />
      </div>
      <div className={s.foot}>
        <a className={s.timeLink} href={one ? `#/time/order/${encodeURIComponent(one)}` : "#/time"}>
          <Text size="xs" tone="inherit">
            Where the time went
          </Text>
        </a>
      </div>
    </div>
  );
}
