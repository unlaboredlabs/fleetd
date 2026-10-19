import type { ReactNode } from "react";
import { cx, StatusChip, Text, Truncate } from "../../ui";
import type { StatusDoc, StatusScope } from "./contracts";
import { TwoToneBar } from "./Hero";
import { NeedsYou } from "./NeedsYou";
import { figure, progressRowView, scopeRoute, staleWords, when } from "./view";
import s from "./status.module.css";

const openOrder = (workstreamId: string): void => {
  window.location.hash = `#/order/${encodeURIComponent(workstreamId)}`;
};
const openScope = (scope: StatusScope): void => {
  window.location.hash = scopeRoute(scope);
};

function Section({ title, count, more, children }: { title: string; count: number; more?: number; children: ReactNode }) {
  const id = `status-${title.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <section className={cx(s.section)} aria-labelledby={id}>
      <h2 id={id} className={cx(s.sectionHead)}>
        <Text size="xs" strong tone="quiet">
          {title} ({count + (more ?? 0)})
        </Text>
      </h2>
      {children}
      {more !== undefined && more > 0 ? (
        <Text size="xs" tone="quiet">
          and {more} more
        </Text>
      ) : null}
    </section>
  );
}

/** A row that opens what it names. Its text wraps; the button is the whole row so it stays one target. */
function Row({ onOpen, children, label }: { onOpen?: (() => void) | undefined; children: ReactNode; label: string }) {
  return onOpen ? (
    <button type="button" className={cx(s.row)} onClick={onOpen} aria-label={label}>
      {children}
    </button>
  ) : (
    <div className={cx(s.row)}>{children}</div>
  );
}

export function Sections({ doc, live, now }: { doc: StatusDoc; live: boolean; now: number }) {
  const partsTitle = doc.scope.kind === "fleet" ? "Projects" : "Milestones";
  return (
    <div className={cx(s.sections)}>
      {doc.parts.length > 0 ? (
        <Section title={partsTitle} count={doc.parts.length} more={doc.more.parts}>
          {doc.parts.map((p) => {
            const f = figure(p.progress);
            const scope = p.scope;
            return (
              <Row key={p.milestoneId ?? p.title} label={`${p.title} status`} onOpen={scope ? () => openScope(scope) : undefined}>
                <span className={cx(s.partTitle)}>
                  <Truncate expand="none">{p.title}</Truncate>
                </span>
                <Text strong tabular className={cx(s.partPct)}>
                  {f.pct === null ? "planning" : `${f.pct}%`}
                </Text>
                <span className={cx(s.partBar)}>
                  <TwoToneBar small verified={f.verifiedPct} inFlight={f.inFlightPct} label={`${f.verifiedPct}% verified`} />
                </span>
                <Text size="xs" tone="quiet" tabular>
                  {p.eta !== undefined ? `eta ${when(p.eta, now)}` : "no ETA yet"}
                </Text>
                {p.progress.marker ? (
                  <Text size="xs" tone="warning">
                    {p.progress.marker.text}
                  </Text>
                ) : null}
                {p.progress.stale ? (
                  <Text size="xs" tone="warning">
                    {staleWords(p.progress.stale, now)}
                  </Text>
                ) : null}
              </Row>
            );
          })}
        </Section>
      ) : null}

      <Section title="Needs you" count={doc.needsYou.count}>
        <NeedsYou askIds={doc.needsYou.askIds} count={doc.needsYou.count} live={live} />
      </Section>

      <Section title="Risks" count={doc.risks.length} more={doc.more.risks}>
        {doc.risks.length === 0 ? (
          <Text size="xs" tone="quiet">
            none fleetd can see
          </Text>
        ) : (
          doc.risks.map((r) => (
            <div key={`${r.rule}${r.message}`} className={cx(s.risk)}>
              <span aria-hidden>
                <Text strong tone={r.level === "danger" ? "danger" : "warning"}>
                  ▲
                </Text>
              </span>
              <Text>{r.message}</Text>
              {r.rule === "slower_than_usual" ? <StatusChip tone="quiet">slower than usual</StatusChip> : null}
            </div>
          ))
        )}
      </Section>

      <Section title="In progress" count={doc.inProgress.length} more={doc.more.inProgress}>
        {doc.inProgress.length === 0 ? (
          <Text size="xs" tone="quiet">
            nothing running
          </Text>
        ) : (
          doc.inProgress.map((r) => {
            const v = progressRowView(r, now);
            return (
              <Row key={`${r.workstreamId}${r.itemId ?? ""}${r.title}`} label={`Open ${r.title}`} onOpen={() => openOrder(r.workstreamId)}>
                <span className={cx(s.rowMain)}>
                  {r.itemId !== undefined ? (
                    <Text size="xs" tone="quiet" tabular>
                      {r.itemId}
                    </Text>
                  ) : null}
                  <Text>{r.title}</Text>
                  {r.slowerThanUsual === true ? <StatusChip tone="failed">slower than usual</StatusChip> : null}
                </span>
                <span className={cx(s.rowMeta)}>
                  {v.meta.map((m) => (
                    <Text key={m} size="xs" tone="quiet">
                      {m}
                    </Text>
                  ))}
                  {v.eta !== null ? (
                    <Text size="xs" tone={v.eta.startsWith("overdue") ? "warning" : "quiet"} tabular>
                      {v.eta}
                    </Text>
                  ) : null}
                </span>
                {r.stale ? (
                  <Text size="xs" tone="warning" className={cx(s.rowFull)}>
                    {staleWords(r.stale, now)}
                  </Text>
                ) : null}
                {(r.steers ?? []).map((st) => (
                  <Text key={st.id} size="xs" tone={st.stage === "unacknowledged" ? "warning" : "quiet"} className={cx(s.rowFull)}>
                    ↳ you steered {when(st.at, now)}: {st.text} · {st.stage.replaceAll("_", " ")}
                    {st.planChange !== undefined ? ` · ${st.planChange}` : ""}
                  </Text>
                ))}
              </Row>
            );
          })
        )}
      </Section>

      <Section title="Next up" count={doc.next.length} more={doc.more.next}>
        {doc.next.length === 0 ? (
          <Text size="xs" tone="quiet">
            nothing queued
          </Text>
        ) : (
          doc.next.map((n) => {
            const ws = n.workstreamId;
            return (
              <Row key={n.itemId} label={`Open ${n.title}`} onOpen={ws !== undefined ? () => openOrder(ws) : undefined}>
                <span className={cx(s.rowMain)}>
                  <Text size="xs" tone="quiet" tabular>
                    {n.itemId}
                  </Text>
                  <Text>{n.title}</Text>
                </span>
                {n.after.length > 0 ? (
                  <Text size="xs" tone="quiet">
                    after {n.after.join(", ")}
                  </Text>
                ) : null}
              </Row>
            );
          })
        )}
      </Section>

      <Section title="Done" count={doc.done.length} more={doc.more.done}>
        {doc.done.length === 0 ? (
          <Text size="xs" tone="quiet">
            nothing verified yet
          </Text>
        ) : (
          doc.done.map((d) => {
            const ws = d.workstreamId;
            return (
              <Row key={`${d.itemId ?? ""}${d.title}${d.doneAt}`} label={`Open ${d.title}`} onOpen={ws !== undefined ? () => openOrder(ws) : undefined}>
                <span className={cx(s.rowMain)}>
                  <span aria-hidden>
                    <Text tone="success">✓</Text>
                  </span>
                  {d.itemId !== undefined ? (
                    <Text size="xs" tone="quiet" tabular>
                      {d.itemId}
                    </Text>
                  ) : null}
                  <Text>{d.title}</Text>
                </span>
                <Text size="xs" tone="quiet" className={cx(s.rowFull)}>
                  {d.evidence} · {when(d.doneAt, now)}
                </Text>
              </Row>
            );
          })
        )}
      </Section>
    </div>
  );
}
