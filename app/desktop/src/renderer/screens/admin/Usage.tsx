// Settings › Workspace › Usage (#/settings/hub/usage), for the workspace's owners and admins: who uses the workspace,
// what it ships and what it costs, over the last 7, 30 or 90 days (`workspace_usage`). The line under the title is
// what runs now; six tiles for the whole workspace against the period before; two charts on one day axis (orders
// started beside PRs merged, then agent hours); then a row per person and per bot. A person's orders, agents, agent
// hours and merges are those of the orders they started; their messages and approvals are their own; what no person
// started is a quiet row of its own. On fleetd cloud, computer time and spend join each. Counts only: nothing here
// says what anyone wrote.
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { WorkspaceUsageCounts, WorkspaceUsageOutput } from "../../../shared/contracts";
import { useToolQuery } from "../../src/data/react";
import { Avatar, Segmented, Text, cx } from "../../ui";
import { columnPath } from "../factory/model";
import { HoverCard, useWidth, type Card, type Hover } from "../factory/charts/parts";
import { PageHead, SettingsSection } from "../settings/parts";
import { roleWord } from "./model";
import {
  PERIODS,
  before,
  change,
  columnsOf,
  count,
  hours,
  idle,
  money,
  onCloud,
  share,
  ticks,
  wait,
  type Better,
  type Column,
  type Period,
} from "../../../shared/usage";
import f from "../factory/Factory.module.css";
import s from "../settings/settings.module.css";
import u from "./usage.module.css";

const viewerZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const PERIOD_KEY = "fleetd.usage.days";
const savedPeriod = (): Period => {
  const v = Number(localStorage.getItem(PERIOD_KEY));
  return PERIODS.find((p) => p === v) ?? 30;
};

export function Usage() {
  const [days, setDays] = useState<Period>(savedPeriod);
  const tz = useMemo(() => viewerZone(), []);
  const query = useToolQuery("workspace_usage", { days, tz }, { keepPrevious: true });
  const pick = (d: Period) => {
    setDays(d);
    localStorage.setItem(PERIOD_KEY, String(d));
  };
  const data = query.data;
  return (
    <div className={s.scroll} data-screen="settings.hub.usage">
      <div className={s.column}>
        <PageHead
          title="Usage"
          aside={<Segmented label="Period" options={PERIODS.map((p) => ({ value: String(p) as `${Period}`, label: `${p} days` }))} value={String(days) as `${Period}`} onChange={(v) => pick(Number(v) as Period)} />}
        />
        {data === undefined ? (
          query.error ? (
            <Text tone="danger">{query.error instanceof Error ? query.error.message : "Usage couldn't be read."}</Text>
          ) : (
            <div className={u.skeleton} aria-busy>
              <span />
              <span />
              <span />
            </div>
          )
        ) : (
          <div className={cx(u.body, query.isFetching && query.isPlaceholderData && u.refetching)}>
            <Page usage={data} days={days} />
          </div>
        )}
      </div>
    </div>
  );
}

function Page({ usage, days }: { usage: WorkspaceUsageOutput; days: Period }) {
  const [hover, setHover] = useState<Hover>();
  const cloud = onCloud(usage);
  const columns = useMemo(() => columnsOf(usage.days), [usage.days]);
  const weekly = columns.length < usage.days.length;
  return (
    <>
      <NowLine usage={usage} />
      <Tiles usage={usage} days={days} cloud={cloud} />
      <section className={u.charts} aria-label="Over time">
        <Bars
          id="usage-work"
          title={weekly ? "Orders and merges per week" : "Orders and merges per day"}
          columns={columns}
          series={[
            { key: "orders", label: "Orders started", slot: f.s1 ?? "", value: (c) => c.orders },
            { key: "merged", label: "PRs merged", slot: f.s3 ?? "", value: (c) => c.merged },
          ]}
          tickLabel={count}
          card={(c) => ({
            title: c.label,
            lines: [
              { text: `${count(c.orders)} orders started`, key: f.s1 },
              { text: `${count(c.merged)} PRs merged`, key: f.s3 },
              ...(c.failed > 0 ? [{ text: `${count(c.failed)} failed or stopped`, tone: "warning" as const }] : []),
            ],
          })}
          onHover={setHover}
        />
        <Bars
          id="usage-hours"
          title={cloud ? (weekly ? "Spend per week" : "Spend per day") : weekly ? "Agent hours per week" : "Agent hours per day"}
          columns={columns}
          series={[
            cloud
              ? { key: "spend", label: "Spend", slot: f.s4 ?? "", value: (c) => c.spendCents ?? 0 }
              : { key: "hours", label: "Agent hours", slot: f.s4 ?? "", value: (c) => c.agentMs },
          ]}
          unit={cloud ? 100 : 3_600_000}
          tickLabel={cloud ? (v) => money(v, usage.currency ?? "USD") : hours}
          card={(c) => ({
            title: c.label,
            lines: [
              ...(cloud ? [{ text: `${money(c.spendCents ?? 0, usage.currency ?? "USD")} spent`, key: f.s4 }] : []),
              { text: `${hours(c.agentMs)} of agents working`, ...(cloud ? {} : { key: f.s4 }) },
            ],
          })}
          onHover={setHover}
        />
      </section>
      <People usage={usage} cloud={cloud} />
      <Bots usage={usage} cloud={cloud} />
      {hover !== undefined ? <HoverCard hover={hover} /> : null}
    </>
  );
}

/** What runs now, the page's one line of state. */
function NowLine({ usage }: { usage: WorkspaceUsageOutput }) {
  const { running, queued, waiting } = usage.now;
  const parts = [`${count(running)} ${running === 1 ? "agent" : "agents"} running now`];
  if (queued > 0) parts.push(`${count(queued)} waiting for a slot`);
  if (waiting > 0) parts.push(`${count(waiting)} ${waiting === 1 ? "approval" : "approvals"} waiting for an answer`);
  return (
    <div className={u.now} role="status">
      <span className={cx(u.nowDot, running > 0 && u.nowLive)} aria-hidden />
      <Text size="sm" tone="quiet">
        {parts.join(" · ")}
      </Text>
    </div>
  );
}

function Tile({ label, value, delta, under, hint }: { label: string; value: string; delta?: ReturnType<typeof change>; under?: ReactNode; hint: string }) {
  return (
    <div className={u.tile} role="group" aria-label={label} title={hint}>
      <Text size="xs" tone="quiet">
        {label}
      </Text>
      <span className={u.tileValue}>
        <Text size="xl" strong tabular>
          {value}
        </Text>
        {delta !== undefined ? (
          <Text size="xs" tone={delta.tone} tabular>
            {delta.text}
          </Text>
        ) : null}
      </span>
      {under === undefined ? null : (
        <Text size="xs" tone="quiet">
          {under}
        </Text>
      )}
    </div>
  );
}

function Tiles({ usage, days, cloud }: { usage: WorkspaceUsageOutput; days: Period; cloud: boolean }) {
  const t = usage.total;
  const p = usage.previous;
  const vs = (now: number | undefined, was: number | undefined, better: Better, as?: "share" | "wait") => change(now, was, better, as);
  const versus = `against ${before(days)}`;
  const currency = usage.currency ?? "USD";
  return (
    <div className={u.tiles}>
      <Tile label="Orders started" value={count(t.orders)} delta={vs(t.orders, p.orders, "up")} under={`${count(t.messages)} messages to leads`} hint={`Orders the workspace's people, automations and the merge train started, ${versus}.`} />
      <Tile label="PRs merged" value={count(t.merged)} delta={vs(t.merged, p.merged, "up")} under={`${count(t.agents)} agents run`} hint={`Pull requests merged through fleetd, ${versus}.`} />
      <Tile
        label="Ask to merge"
        value={t.askToMergeMs === undefined ? "—" : wait(t.askToMergeMs)}
        delta={vs(t.askToMergeMs, p.askToMergeMs, "down", "wait")}
        under="median"
        hint={`From a person's ask to its PR merged, the middle of the period's merges, ${versus}.`}
      />
      {cloud ? (
        <Tile
          label="Spend"
          value={money(t.spendCents ?? 0, currency)}
          delta={vs(t.spendCents, p.spendCents, "none")}
          under={`${hours(t.computerMs ?? 0)} on fleetd's computers`}
          hint={`What time on fleetd's computers cost, ${versus}.`}
        />
      ) : null}
      <Tile label="Agent hours" value={hours(t.agentMs)} delta={vs(t.agentMs, p.agentMs, "none")} under="working, not waiting" hint={`Agents thinking, running tools and starting up; not their waits. ${versus[0]?.toUpperCase()}${versus.slice(1)}.`} />
      <Tile label="Approvals answered" value={count(t.approvals)} delta={vs(t.approvals, p.approvals, "none")} under={usage.now.waiting > 0 ? `${count(usage.now.waiting)} waiting now` : "none waiting"} hint={`Approvals and secret requests people answered, ${versus}.`} />
      <Tile label="Failed or stopped" value={count(t.failed)} delta={vs(t.failed, p.failed, "down")} under="agents and orders" hint={`Agents that failed, and orders stopped before they were done, ${versus}.`} />
    </div>
  );
}

// ---- charts ---------------------------------------------------------------------------------------------------------

interface BarSeries {
  readonly key: string;
  readonly label: string;
  readonly slot: string;
  readonly value: (c: Column) => number;
}

const PLOT_H = 120;
const TOP = 8;
const BOTTOM = 20;
const LEFT = 44;
const RIGHT = 8;
const MAX_BAR = 14;
const X_LABEL_W = 64;

/**
 * Columns on one axis from 0, each series a bar side by side in its slot (dataviz: thin marks, 2 px between,
 * rounded tops on the baseline). Each slot is its hit target over the whole plot, and the arrow keys walk them with
 * the same card.
 */
function Bars(p: {
  id: string;
  title: string;
  columns: readonly Column[];
  series: readonly BarSeries[];
  unit?: number;
  tickLabel: (v: number) => string;
  card: (c: Column) => Card;
  onHover: (h: Hover | undefined) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const [active, setActive] = useState<number>();
  const n = p.columns.length;
  const plotW = Math.max(0, width - LEFT - RIGHT);
  const slot = n === 0 ? 0 : plotW / n;
  const k = p.series.length;
  const bar = Math.max(2, Math.min(MAX_BAR, (slot - 4 - 2 * (k - 1)) / k));
  const group = bar * k + 2 * (k - 1);
  const max = Math.max(0, ...p.columns.flatMap((c) => p.series.map((x) => x.value(c))));
  const axis = ticks(max, p.unit ?? 1);
  const top = axis.at(-1) ?? 1;
  const baseline = TOP + PLOT_H;
  const px = (v: number) => (v / top) * PLOT_H;
  const every = Math.max(1, Math.ceil(X_LABEL_W / Math.max(1, slot)));
  const show = (i: number, at?: { x: number; y: number }) => {
    const c = p.columns[i];
    if (c === undefined) return;
    setActive(i);
    const r = box.current?.getBoundingClientRect();
    p.onHover({ card: p.card(c), x: at?.x ?? (r?.left ?? 0) + LEFT + (i + 1) * slot, y: at?.y ?? (r?.top ?? 0) + TOP });
  };
  const hide = () => {
    setActive(undefined);
    p.onHover(undefined);
  };
  const onKey = (e: KeyboardEvent) => {
    const at = active ?? -1;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      show(Math.min(n - 1, Math.max(0, e.key === "ArrowRight" ? at + 1 : at < 0 ? n - 1 : at - 1)));
    } else if (e.key === "Escape") hide();
  };
  return (
    <div className={u.chart}>
      <div className={u.chartHead}>
        <Text as="h2" strong id={p.id}>
          {p.title}
        </Text>
        {k > 1 ? (
          <div className={f.legend} aria-hidden>
            {p.series.map((x) => (
              <span key={x.key} className={f.key}>
                <span className={cx(f.swatch, x.slot)} />
                <Text size="xs" tone="quiet">
                  {x.label}
                </Text>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div ref={box} className={f.plot}>
        {width > 0 ? (
          <svg width={width} height={baseline + BOTTOM} role="img" aria-labelledby={p.id} tabIndex={0} onKeyDown={onKey} onBlur={hide} onPointerLeave={hide}>
            {axis.map((t) => (
              <g key={t}>
                <line className={t === 0 ? f.baseline : f.grid} x1={LEFT} x2={LEFT + plotW} y1={baseline - px(t)} y2={baseline - px(t)} />
                <text className={f.tick} x={LEFT - 6} y={baseline - px(t)} dy="0.32em" textAnchor="end">
                  {p.tickLabel(t)}
                </text>
              </g>
            ))}
            {p.columns.map((c, i) => {
              const x0 = LEFT + i * slot + (slot - group) / 2;
              return (
                <g key={c.from}>
                  {p.series.map((x, j) => {
                    const h = px(x.value(c));
                    if (h <= 0) return null;
                    const hh = Math.max(1, h);
                    return <path key={x.key} className={x.slot} d={columnPath(x0 + j * (bar + 2), baseline - hh, bar, hh, true)} />;
                  })}
                  {(n - 1 - i) % every === 0 && i * slot + slot / 2 >= X_LABEL_W / 2 ? (
                    <text className={f.tick} x={LEFT + i * slot + slot / 2} y={baseline + 14} textAnchor="middle">
                      {c.label.split(" to ")[0]}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {p.columns.map((c, i) => (
              <rect
                key={c.from}
                className={cx(f.hit, active === i && f.active)}
                x={LEFT + i * slot}
                y={TOP}
                width={slot}
                height={PLOT_H}
                onPointerMove={(e) => show(i, { x: e.clientX, y: e.clientY })}
              />
            ))}
          </svg>
        ) : (
          <div style={{ height: baseline + BOTTOM }} />
        )}
      </div>
    </div>
  );
}

// ---- tables ---------------------------------------------------------------------------------------------------------

interface Col {
  readonly key: string;
  readonly label: string;
  readonly hint: string;
  readonly cell: (c: WorkspaceUsageCounts) => string;
  /** The column whose figure each row's bar draws, against the largest. */
  readonly bar?: (c: WorkspaceUsageCounts) => number;
}

/** On fleetd cloud, computer time and spend take the place of agent hours and of the agents run, which the tiles keep. */
const cols = (cloud: boolean, currency: string, who: "people" | "bots"): Col[] => (cloud ? all(cloud, currency, who).filter((c) => c.key !== "agents") : all(cloud, currency, who));

const all = (cloud: boolean, currency: string, who: "people" | "bots"): Col[] => {
  const spend = cloud
    ? [{ key: "spend", label: "Spend", hint: "What their time on fleetd's computers cost.", cell: (c: WorkspaceUsageCounts) => money(c.spendCents ?? 0, currency) }]
    : [];
  const time: Col = cloud
    ? { key: "computer", label: "Computer", hint: "Time on fleetd's computers.", cell: (c) => hours(c.computerMs ?? 0), bar: (c) => c.computerMs ?? 0 }
    : { key: "hours", label: "Hours", hint: "Agent hours: agents working (thinking, running tools, starting up), not waiting.", cell: (c) => hours(c.agentMs), bar: (c) => c.agentMs };
  if (who === "people") {
    return [
      { key: "messages", label: "Messages", hint: "Messages they wrote to a lead.", cell: (c) => count(c.messages) },
      { key: "orders", label: "Orders", hint: "Orders they started.", cell: (c) => count(c.orders) },
      { key: "agents", label: "Agents", hint: "Agents their orders ran: writers, readers, reviewers.", cell: (c) => count(c.agents) },
      time,
      { key: "merged", label: "Merged", hint: "PRs their orders merged.", cell: (c) => count(c.merged) },
      { key: "approvals", label: "Approvals", hint: "Approvals and secret requests they answered.", cell: (c) => count(c.approvals) },
      ...spend,
    ];
  }
  return [
    { key: "orders", label: "Orders", hint: "Orders started on it.", cell: (c) => count(c.orders) },
    { key: "agents", label: "Agents", hint: "Agents it ran, its lead's aside.", cell: (c) => count(c.agents) },
    { ...time, hint: cloud ? time.hint : "Its agents and its lead working." },
    { key: "merged", label: "Merged", hint: "PRs merged.", cell: (c) => count(c.merged) },
    { key: "ask", label: "To merge", hint: "From the ask to its PR merged, the median.", cell: (c) => (c.askToMergeMs === undefined ? "—" : wait(c.askToMergeMs)) },
    { key: "failed", label: "Failed", hint: "Agents failed and orders stopped.", cell: (c) => count(c.failed) },
    ...spend,
  ];
};

interface Row {
  readonly key: string;
  readonly head: ReactNode;
  readonly label: string;
  readonly counts: WorkspaceUsageCounts;
  readonly quiet?: boolean;
}

function Table({ label, columns, rows }: { label: string; columns: Col[]; rows: Row[] }) {
  const bar = columns.find((c) => c.bar !== undefined)?.bar;
  const max = bar === undefined ? 0 : Math.max(0, ...rows.map((r) => bar(r.counts)));
  return (
    <table className={u.table} aria-label={label}>
      <thead>
        <tr>
          <th scope="col" className={u.nameCol}>
            <span className={u.srOnly}>{label}</span>
          </th>
          {columns.map((c) => (
            <th key={c.key} scope="col" title={c.hint}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={cx(r.quiet === true && u.quietRow)}>
            <th scope="row" className={u.nameCol}>
              {r.head}
            </th>
            {columns.map((c) => (
              <td key={c.key}>
                {c.bar !== undefined ? (
                  <span className={u.barCell}>
                    <span className={u.bar} aria-hidden>
                      <span style={{ width: `${Math.round(share(c.bar(r.counts), max) * 100)}%` }} />
                    </span>
                    {c.cell(r.counts)}
                  </span>
                ) : (
                  c.cell(r.counts)
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function People({ usage, cloud }: { usage: WorkspaceUsageOutput; cloud: boolean }) {
  const columns = cols(cloud, usage.currency ?? "USD", "people");
  const rows: Row[] = usage.members.map((m) => ({
    key: m.person.personId,
    label: m.person.name,
    counts: m.counts,
    quiet: m.removed === true || idle(m.counts),
    head: (
      <span className={u.who}>
        <Avatar name={m.person.name} size={22} />
        <span className={u.whoText}>
          <Text className={u.cut}>
            {m.person.name}
          </Text>
          <Text size="xs" tone="quiet">
            {m.removed === true ? "Removed" : roleWord(m.role)}
          </Text>
        </span>
      </span>
    ),
  }));
  if (!idle(usage.unattributed)) {
    rows.push({
      key: "none",
      label: "No one",
      counts: usage.unattributed,
      quiet: true,
      head: (
        <span className={u.who}>
          <span className={u.noOne} aria-hidden />
          <span className={u.whoText}>
            <Text>No one</Text>
            <Text size="xs" tone="quiet">
              Automations, lead chats
            </Text>
          </span>
        </span>
      ),
    });
  }
  return (
    <SettingsSection title="People" hint="A person's orders, agents, agent hours and merges are those of the orders they started; their messages and approvals are their own. No one holds what automations and the merge train started, and the leads' time not spent on an order.">
      <Table label="People" columns={columns} rows={rows} />
    </SettingsSection>
  );
}

function Bots({ usage, cloud }: { usage: WorkspaceUsageOutput; cloud: boolean }) {
  if (usage.bots.length === 0) return null;
  const columns = cols(cloud, usage.currency ?? "USD", "bots");
  const rows: Row[] = usage.bots.map((b) => ({
    key: b.projectRef === undefined ? "removed" : `${b.projectRef.machineId}/${b.projectRef.projectId}`,
    label: b.name,
    counts: b.counts,
    quiet: b.projectRef === undefined,
    head: (
      <Text className={u.cut}>
        {b.name}
      </Text>
    ),
  }));
  return (
    <SettingsSection title="Bots">
      <Table label="Bots" columns={columns} rows={rows} />
    </SettingsSection>
  );
}
