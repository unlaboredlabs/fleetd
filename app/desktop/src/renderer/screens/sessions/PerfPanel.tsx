// A live screen's performance panel, beside the screen and never over it: the verdict in words (perfModel.ts), the
// frames shown each second over the last minute, then the measures under quiet labels. Closed by default; its toggle
// is in the view's line and ⌘⇧P (Ctrl+Shift+P), and the choice holds for every screen (perf.ts).
import { X } from "lucide-react";
import { Button, Text, Tooltip } from "../../ui";
import { display } from "../../../shared/shortcuts";
import { GRAPH_H, GRAPH_W, graphOf, groupsOf, LOST_SHARE, verdictOf, type GraphSecond, type PerfNow } from "./perfModel";
import type { SessionKind } from "../../../shared/contracts";
import s from "./sessions.module.css";

/** Frames a second over the last minute: what this window showed as a line, what the screen made as a faint one, and
 * the frames it didn't show between them, filled. Steady, the two lines run together near the top. */
function Graph({ history }: { history: readonly GraphSecond[] }) {
  const g = graphOf(history);
  const now = history.at(-1);
  return (
    <div className={s.perfGraph}>
      <div className={s.perfGraphHead}>
        <Text size="xs" tone="quiet">
          Frames a second
        </Text>
        <Text size="xs" tone={now !== undefined && now.shown < now.made * (1 - LOST_SHARE) ? "warning" : "faint"} tabular>
          {now === undefined ? "" : `${String(now.shown)} shown of ${String(now.made)} sent`}
        </Text>
      </div>
      <svg
        className={s.perfChart}
        viewBox={`0 0 ${String(GRAPH_W)} ${String(GRAPH_H)}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={now === undefined ? "Frames a second over the last minute" : `Frames a second over the last minute: ${String(now.shown)} shown of ${String(now.made)} sent now`}
      >
        <path d={g.gap} className={s.perfGap} />
        <path d={g.target} className={s.perfMade} />
        <path d={g.shown} className={s.perfShown} />
        <line x1="0" x2={GRAPH_W} y1={GRAPH_H - 0.5} y2={GRAPH_H - 0.5} className={s.perfBase} />
      </svg>
      <div className={s.perfAxis}>
        <Text size="xs" tone="faint">
          1 min ago
        </Text>
        <Text size="xs" tone="faint">
          now
        </Text>
      </div>
    </div>
  );
}

export function PerfPanel({
  now,
  kind,
  screen,
  shownWidth,
  direct,
  machine,
  onClose,
}: {
  now: PerfNow | undefined;
  kind: SessionKind | undefined;
  screen: { width: number; height: number } | undefined;
  shownWidth: number | undefined;
  direct: boolean;
  machine: string | undefined;
  onClose: () => void;
}) {
  const verdict = verdictOf(now);
  const groups = groupsOf(now, { kind, screen, shownWidth, direct, machine });
  return (
    <aside className={s.perf} aria-label="Performance">
      <span className={s.stepsHead}>
        <Text size="xs" tone="quiet" strong>
          Performance
        </Text>
        <span className={s.headGap} />
        <Tooltip content={`Hide performance · ${display("session.perf", window.fleetd.platform)}`}>
          <Button variant="quiet" size="sm" iconOnly icon={<X aria-hidden />} aria-label="Hide performance" onClick={onClose} />
        </Tooltip>
      </span>
      <div className={s.perfBody}>
        <div className={s.perfVerdict} role="status">
          <Text size="md" tone={verdict.tone === "quiet" ? "default" : verdict.tone} strong>
            {verdict.word}
          </Text>
          <Text size="xs" tone="quiet">
            {verdict.line}
          </Text>
        </div>
        <Graph history={now?.history ?? []} />
        {groups.map((g) => (
          <section key={g.label} className={s.perfGroup} aria-label={g.label}>
            <Text size="xs" tone="faint" className={s.perfLabel}>
              {g.label}
            </Text>
            <dl className={s.perfRows}>
              {g.rows.map((r) => (
                <div key={r.label} className={s.perfRow}>
                  <dt>
                    <Text size="xs" tone="quiet">
                      {r.label}
                    </Text>
                  </dt>
                  <dd>
                    <Text size="xs" tabular tone={r.tone === "warning" ? "warning" : "default"}>
                      {r.value}
                    </Text>
                    {r.note === undefined ? null : (
                      <Text size="xs" tone={r.tone === "warning" ? "warning" : "faint"}>
                        {r.note}
                      </Text>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </aside>
  );
}
