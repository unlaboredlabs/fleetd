import { Dot, Text, Tooltip } from "../../ui";
import type { StaleMark, StatusDoc } from "./contracts";
import { age, asOf, machineView, staleAge, staleWords, usageView, when } from "./view";
import s from "./status.module.css";

const CI_DOT: Record<string, string> = {
  green: "var(--success)",
  red: "var(--danger)",
  pending: "var(--warning)",
};

/** A part of the strip: its value, its as-of on hover, and a visible stale mark with the reason. */
function Part({ children, stale, asOfText, now }: { children: React.ReactNode; stale?: StaleMark | undefined; asOfText: string; now: number }) {
  return (
    <Tooltip content={stale ? `${staleWords(stale, now)} (${asOfText})` : asOfText}>
      <span className={stale ? s.partStale : s.part} tabIndex={0}>
        {children}
        {stale ? (
          <Text size="xs" strong tone="warning" tabular>
            {staleAge(stale, now)}
          </Text>
        ) : null}
      </span>
    </Tooltip>
  );
}

/** Main CI, machines, claude usage and agents, each with its own as-of. Slots are hub-local and never stale. */
export function Health({ doc, now }: { doc: StatusDoc; now: number }) {
  const h = doc.health;
  const online = h.machines.filter((m) => m.status === "online").length;
  const notable = h.machines.filter((m) => m.status !== "online" || m.slept !== undefined || m.dropsToday > 1 || m.stale);
  const usage = usageView(h.usage);
  return (
    <section className={s.health} aria-label="Health">
      <div className={s.healthLine}>
        <Text size="xs" tone="quiet">
          main CI
        </Text>
        {h.ci.length === 0 ? (
          <Text size="xs" tone="quiet">
            no repos on the train
          </Text>
        ) : (
          h.ci.map((c) => (
            <Part key={c.repo} stale={c.stale} now={now} asOfText={`GitHub ${asOf(c.asOf, now)}`}>
              <Dot color={CI_DOT[c.state] ?? "var(--faint)"} label={c.state === "unknown" ? "not checked yet" : c.state} />
              <Text size="xs">{c.repo}</Text>
              {c.state === "red" && c.failing.length > 0 ? (
                <Text size="xs" tone="danger">
                  {c.failing.join(", ")}
                </Text>
              ) : null}
              {c.state === "unknown" ? (
                <Text size="xs" tone="quiet">
                  not checked yet
                </Text>
              ) : c.since !== undefined ? (
                <Text size="xs" tone="quiet" tabular>
                  {c.state} since {when(c.since, now)}
                </Text>
              ) : null}
            </Part>
          ))
        )}
      </div>
      <div className={s.healthLine}>
        <Text size="xs" tone="quiet">
          machines
        </Text>
        <Text size="xs" tabular>
          {online} of {h.machines.length} online
        </Text>
        {notable.map((m) => {
          const seen = m.lastSeenAt !== undefined ? Date.parse(m.lastSeenAt) : Number.NaN;
          return (
            <Part
              key={m.machineId}
              stale={m.stale}
              now={now}
              asOfText={Number.isNaN(seen) ? "never seen" : `last heartbeat ${age(now - seen)} ago`}
            >
              <Dot color={m.status === "online" ? "var(--success)" : "var(--warning)"} label={m.status} />
              <Text size="xs">{m.machineId}</Text>
              <Text size="xs" tone="quiet" tabular>
                {machineView(m, now)}
              </Text>
            </Part>
          );
        })}
      </div>
      <div className={s.healthLine}>
        <Text size="xs" tone="quiet">
          claude
        </Text>
        {usage.length === 0 ? (
          <Text size="xs" tone="quiet">
            no usage reading yet
          </Text>
        ) : (
          usage.map((u) => (
            <Part
              key={u.row.limitType}
              stale={u.row.stale}
              now={now}
              asOfText={`read on ${u.row.machineId} ${asOf(u.row.observedAt, now)}${u.row.resetsAt !== undefined ? `, resets ${when(u.row.resetsAt, now)}` : ""}`}
            >
              <Text size="xs" tabular tone={(u.row.utilization ?? 0) >= 0.9 ? "danger" : "default"}>
                {u.label}
              </Text>
            </Part>
          ))
        )}
        <Text size="xs" tone="quiet">
          agents
        </Text>
        <Text size="xs" tabular>
          {h.slots.running} running · slots {h.slots.used}/{h.slots.cap}
          {h.slots.queued > 0 ? ` · ${h.slots.queued} queued` : ""}
        </Text>
      </div>
    </section>
  );
}
