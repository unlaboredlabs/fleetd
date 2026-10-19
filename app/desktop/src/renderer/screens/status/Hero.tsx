import { cx, Text, Tooltip } from "../../ui";
import type { ProgressPoint, StatusDoc } from "./contracts";
import { useTween } from "./hooks";
import {
  asOf,
  etaView,
  figure,
  headlineText,
  markerDirection,
  sinceView,
  spark,
  staleWords,
  when,
  type Figure,
} from "./view";
import s from "./status.module.css";

/** The number, its bars, the sparkline, the headline, the ETA and since-you-last-looked. */
export function Hero({ doc, live, session, now }: { doc: StatusDoc; live: boolean; session: string; now: number }) {
  const f = figure(doc.progress, doc.virtualTier);
  const stale = doc.progress.stale;
  return (
    <section className={stale ? s.heroStale : s.hero} aria-label="Progress">
      <FigureBlock f={f} session={session} live={live} meta={[...f.detail, asOf(doc.progress.asOf, now)]} />
      {stale ? (
        <Text size="xs" tone="warning">
          {staleWords(stale, now)}
        </Text>
      ) : null}
      <Markers doc={doc} now={now} />
      <Sparkline series={doc.progress.estimate?.series ?? []} now={now} />
      <Headline doc={doc} live={live} now={now} />
      <Eta doc={doc} now={now} />
      <SinceLine doc={doc} now={now} />
    </section>
  );
}

/** The number (or "planning") with its meta on one line, and the bar across the full width under it. */
function FigureBlock({ f, session, live, meta }: { f: Figure; session: string; live: boolean; meta: readonly string[] }) {
  const pct = f.pct ?? 0;
  // The figure tweens only while live; a not-live gap is its own session (session.ts bumps it).
  const shown = useTween(pct, live ? session : `${session}:still`);
  const k = pct === 0 ? 1 : shown / pct;
  return (
    <>
      <div className={cx(s.figureRow)}>
        <div className={cx(s.numberLine)}>
          {f.planning === null ? (
            <Text size="display" strong tabular className={cx(s.number)}>
              {`${Math.round(shown)}%`}
            </Text>
          ) : (
            <Text size="xl" strong>
              planning
            </Text>
          )}
          {f.planning !== null ? (
            <Text size="xs" tone="quiet">
              the lead is writing the plan; progress counts once it has items
            </Text>
          ) : f.verifiedNote !== null ? (
            <Text size="xs" tone="quiet" tabular>
              {f.verifiedNote}
            </Text>
          ) : null}
          {!live ? (
            <Text size="xs" strong tone="warning">
              not live
            </Text>
          ) : null}
        </div>
        <div className={cx(s.figureMeta)}>
          {meta.map((d) => (
            <Text key={d} size="xs" tone="quiet" tabular>
              {d}
            </Text>
          ))}
        </div>
      </div>
      {f.planning === null ? (
        <TwoToneBar verified={f.verifiedPct * k} inFlight={f.inFlightPct * k} label={`${pct}% estimated, ${f.verifiedPct}% verified`} />
      ) : (
        <div className={cx(s.planningBar)} role="img" aria-label={`planning ${f.planning}% of its usual time`}>
          <div className={cx(s.barInFlight)} style={{ width: `${f.planning}%` }} />
        </div>
      )}
    </>
  );
}

/** Solid: verified by fleetd. Lighter: credit for the stages fleetd observed on work in flight. */
export function TwoToneBar({ verified, inFlight, label, small }: { verified: number; inFlight: number; label: string; small?: boolean }) {
  return (
    <div className={small ? s.barSmall : s.bar} role="img" aria-label={label}>
      <div className={cx(s.barVerified)} style={{ width: `${verified}%` }} />
      <div className={cx(s.barInFlight)} style={{ width: `${inFlight}%` }} />
    </div>
  );
}

function Markers({ doc, now }: { doc: StatusDoc; now: number }) {
  if (doc.markers.length === 0) return null;
  return (
    <ul className={cx(s.markers)} aria-label="Scope changes">
      {doc.markers.map((m) => {
        const dir = markerDirection(m.pctBefore, m.pctAfter);
        return (
          <li key={`${m.at}${m.text}`} className={cx(s.markerRow)}>
            {dir ? (
              <Text size="xs" strong tone={dir.down ? "warning" : "quiet"} tabular>
                {dir.text}
              </Text>
            ) : null}
            <Text size="xs" tone="quiet">
              {m.text} · {when(m.at, now)}
            </Text>
          </li>
        );
      })}
    </ul>
  );
}

const SPARK_W = 600;
const SPARK_H = 56;

/** The estimate over time (and verified under it). Every drop has a marker whose explanation is listed below the
 * line, so a fall is never silent. */
function Sparkline({ series, now }: { series: readonly ProgressPoint[]; now: number }) {
  const g = spark(series, SPARK_W, SPARK_H);
  if (!g) return null;
  const drops = g.drops.slice(-3);
  return (
    <figure className={cx(s.spark)}>
      <svg viewBox={`-4 -4 ${SPARK_W + 8} ${SPARK_H + 8}`} preserveAspectRatio="none" className={cx(s.sparkSvg)} role="img" aria-label="Progress over time">
        <path d={g.verified} className={cx(s.sparkVerified)} vectorEffect="non-scaling-stroke" />
        <path d={g.estimate} className={cx(s.sparkEstimate)} vectorEffect="non-scaling-stroke" />
        {g.drops.map((d, i) => (
          <circle key={`${d.at}${String(i)}`} cx={d.x} cy={d.y} r={3} className={cx(s.sparkDrop)} vectorEffect="non-scaling-stroke">
            <title>{d.label}</title>
          </circle>
        ))}
      </svg>
      {drops.length > 0 ? (
        <figcaption className={cx(s.drops)}>
          {drops.map((d, i) => (
            <Text key={`${d.at}${String(i)}`} size="xs" tone="quiet">
              <span className={cx(s.dropDot)} aria-hidden /> {when(d.at, now)} {d.label}
            </Text>
          ))}
        </figcaption>
      ) : null}
    </figure>
  );
}

function Headline({ doc, live, now }: { doc: StatusDoc; live: boolean; now: number }) {
  const h = doc.headline;
  const generated = h.source === "generated";
  const why = generated ? `written ${when(h.at, now)} from the facts` : (h.reason ?? "no generated line yet");
  return (
    <div className={cx(s.headline)}>
      <Text className={cx(s.grow)}>{headlineText(doc, live)}</Text>
      <Tooltip content={`${why}. Every number in it comes from fleetd; claude only phrases the line.`}>
        <span className={cx(s.tag)} tabIndex={0}>
          <Text size="xs" tone="quiet">
            {generated ? "generated" : "template"}
          </Text>
        </span>
      </Tooltip>
    </div>
  );
}

function Eta({ doc, now }: { doc: StatusDoc; now: number }) {
  const e = etaView(doc.eta, now);
  return (
    <div className={cx(s.etaBlock)}>
      <div className={cx(s.inline)}>
        {e.isRange ? (
          <Tooltip content="Likely (half of similar work finishes by the first time) to at the latest (nine in ten by the second).">
            <span tabIndex={0}>
              <Text strong tabular>
                {e.main}
              </Text>
            </span>
          </Tooltip>
        ) : (
          <Text strong={e.main.startsWith("eta")} tone={e.main.startsWith("eta") ? "default" : "quiet"} tabular>
            {e.main}
          </Text>
        )}
        {e.rest.map((r) => (
          <Text key={r} size="xs" tone="quiet" tabular>
            {r}
          </Text>
        ))}
      </div>
      {doc.gates.length > 0 ? (
        <div className={cx(s.inline)}>
          <Text size="xs" tone="quiet">
            waiting on
          </Text>
          {doc.gates.map((g) => (
            <Text key={g.label} size="xs" strong={g.serial}>
              {g.serial ? `${g.label} (serial)` : g.label}
              {g.since !== undefined ? ` · since ${when(g.since, now)}` : ""}
            </Text>
          ))}
        </div>
      ) : null}
      {e.drift !== null ? (
        <Text size="xs" tone="warning">
          {e.drift}
        </Text>
      ) : null}
      {e.accuracy !== null ? (
        <Text size="xs" tone="quiet">
          {e.accuracy}
        </Text>
      ) : null}
    </div>
  );
}

function SinceLine({ doc, now }: { doc: StatusDoc; now: number }) {
  const v = sinceView(doc.since, now);
  return (
    <div className={cx(s.inline)}>
      <Text size="xs" tone="quiet">
        {v.lead}
      </Text>
      {v.parts.length === 0 ? (
        <Text size="xs" tone="quiet">
          nothing new
        </Text>
      ) : (
        v.parts.map((p) => (
          <Text key={p.text} size="xs" strong tone={p.bad ? "danger" : "default"} tabular>
            {p.text}
          </Text>
        ))
      )}
    </div>
  );
}
