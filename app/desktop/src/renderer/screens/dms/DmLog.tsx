// Activity › DMs: every DM between the project's agents, newest first, one line each (sender → recipients, the
// opening words, what became of it, the time) under its day's name. A line opens in place to the full words and a
// receipt per recipient, ending with the lead's quiet copy. "Any agent" narrows it to one agent's DMs. Read-only for
// everyone, members and admins alike: a DM is the log, never edited or deleted.
import { Ban, ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useData } from "../../src/data/react";
import { Button, EmptyState, Select, Text, Truncate, VirtualList, cx } from "../../ui";
import { dayLabel } from "../chat/model";
import { shortClock } from "../chat/format";
import { useNow } from "../live/clock";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import { useDmLog, type DmLog as Log } from "./hooks";
import { logReceipt, notWoken, opening, route, rowState, type AgentMessage } from "./model";
import s from "./dms.module.css";

const ANY = "any";

type Item =
  | { readonly t: "day"; readonly key: string; readonly label: string }
  | { readonly t: "dm"; readonly key: string; readonly dm: AgentMessage }
  | { readonly t: "end"; readonly key: string };

/** The log's rows: a day's name over its DMs, then the foot. */
export function dmRows(messages: readonly AgentMessage[], nowMs: number, timeZone?: string): Item[] {
  const rows: Item[] = [];
  let day: string | undefined;
  for (const dm of messages) {
    const label = dayLabel(dm.sentAt, nowMs, timeZone);
    if (label !== day) {
      day = label;
      rows.push({ t: "day", key: `day:${label}`, label });
    }
    rows.push({ t: "dm", key: dm.id, dm });
  }
  return messages.length === 0 ? rows : [...rows, { t: "end", key: "end" }];
}

/** The agents a list of DMs names, for the picker: id and title, by id. */
const agentsOf = (messages: readonly AgentMessage[]): { taskId: string; title: string }[] => {
  const byId = new Map<string, string>();
  const keep = (taskId: string, title: string | undefined) => {
    if (title !== undefined || !byId.has(taskId)) byId.set(taskId, title ?? "");
  };
  for (const m of messages) {
    keep(m.from.taskId, m.from.title);
    for (const t of m.to) keep(t.taskId, t.title);
  }
  return [...byId].map(([taskId, title]) => ({ taskId, title })).sort((a, b) => (Number(b.taskId.slice(1)) || 0) - (Number(a.taskId.slice(1)) || 0));
};

export function DmLog({ project }: { project: ProjectKey }) {
  const [agent, setAgent] = useState<string>(ANY);
  const log = useDmLog(project, agent === ANY ? undefined : agent);
  const fresh = useData((st) => st.fresh);
  const nowMs = useNow(true, 60_000);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  // The picker names the agents in the DMs on view: narrowed to one, that agent and those it wrote with.
  const known = useMemo(() => (log.messages === undefined ? [] : agentsOf(log.messages)), [log.messages]);
  const items = useMemo(() => (log.messages === undefined ? undefined : dmRows(log.messages, nowMs)), [log.messages, nowMs]);
  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className={s.log} data-screen={items === undefined && log.error === null ? "activity.dms.loading" : "activity.dms"}>
      <div className={s.filterRow}>
        <Text size="xs" tone="quiet">
          Every DM between this project’s agents, newest first
        </Text>
        {known.length === 0 ? null : (
          <Select
            className={s.pick}
            aria-label="Whose DMs"
            value={agent}
            onValueChange={setAgent}
            options={[{ value: ANY, label: "Any agent" }, ...known.map((a) => ({ value: a.taskId, label: a.title === "" ? a.taskId : `${a.taskId} · ${a.title}`, textValue: a.taskId }))]}
          />
        )}
      </div>
      {log.error !== null && items === undefined ? (
        <EmptyState
          tone="danger"
          title="Couldn’t read the DMs"
          actions={
            <Button variant="secondary" size="sm" onClick={log.retry}>
              Retry
            </Button>
          }
        >
          {log.error.message}
        </EmptyState>
      ) : items === undefined && !fresh ? (
        <div className={s.note}>
          <Text tone="quiet">DMs show once you’re connected.</Text>
        </div>
      ) : items === undefined ? (
        <div aria-busy="true" aria-label="Loading the DMs" />
      ) : items.length === 0 ? (
        <EmptyState title={agent === ANY ? "No DMs yet" : `No DMs for ${agent}`}>
          When this project’s agents tell each other something, every message shows here with what became of it.
        </EmptyState>
      ) : (
        <div className={s.list}>
          <VirtualList
            items={items}
            getKey={(item) => item.key}
            renderItem={(item) =>
              item.t === "day" ? (
                <div className={s.day} role="heading" aria-level={3}>
                  <Text size="xs" tone="quiet" strong>
                    {item.label}
                  </Text>
                </div>
              ) : item.t === "dm" ? (
                <DmRow dm={item.dm} project={project} open={open.has(item.dm.id)} onToggle={toggle} />
              ) : (
                <End log={log} />
              )
            }
            estimateSize={30}
            aria-label="DMs"
          />
        </div>
      )}
    </div>
  );
}

function DmRow({ dm, project, open, onToggle }: { dm: AgentMessage; project: ProjectKey; open: boolean; onToggle: (id: string) => void }) {
  const state = rowState(dm);
  const Icon = notWoken(dm) === undefined ? MessageSquare : Ban;
  const Chevron = open ? ChevronDown : ChevronRight;
  const fullId = `dm-${dm.id}`;
  return (
    <div data-dm={dm.id}>
      <button type="button" className={cx(s.line, open && s.open)} aria-expanded={open} aria-controls={open ? fullId : undefined} onClick={() => onToggle(dm.id)}>
        <span className={s.icon}>
          <Icon size={14} strokeWidth={1.75} aria-hidden />
        </span>
        <span className={s.who}>
          <Truncate size="sm" expand="none" strong>
            {route(dm)}
          </Truncate>
        </span>
        <span className={s.what}>
          <Truncate size="xs" tone="quiet" expand="none">
            {opening(dm.text)}
          </Truncate>
        </span>
        <span className={s.state}>
          <Text size="xs" tone={state.text.startsWith("not sent") ? "danger" : state.strong ? "default" : "quiet"} strong={state.strong}>
            {state.text}
          </Text>
        </span>
        <Text size="xs" tone="faint" tabular>
          {shortClock(dm.sentAt)}
        </Text>
        <Chevron className={s.icon} size={14} aria-hidden />
      </button>
      {open ? (
        <div className={s.full} id={fullId}>
          <Text as="p" size="md" preserveLines className={s.words}>
            {dm.text}
          </Text>
          <dl className={s.receipts} aria-label="What became of it">
            <dt>
              <AgentLink project={project} taskId={dm.from.taskId} title={dm.from.title} />
            </dt>
            <dd>sent it</dd>
            <dd className={s.time}>{shortClock(dm.sentAt)}</dd>
            {dm.to.map((t) => (
              <Recipient key={t.taskId} project={project} t={t} sentAt={dm.sentAt} />
            ))}
            <dt>Lead</dt>
            <dd>had a copy with its next wake</dd>
            <dd className={s.time}>{shortClock(dm.sentAt)}</dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function Recipient({ project, t, sentAt }: { project: ProjectKey; t: AgentMessage["to"][number]; sentAt: string }) {
  const guard = t.outcome === "woke" || t.outcome === "not_woken";
  return (
    <>
      <dt>
        <AgentLink project={project} taskId={t.taskId} title={t.title} />
      </dt>
      <dd className={cx(guard && s.guard, t.outcome === "refused" && s.failed)} data-outcome={t.outcome}>
        {logReceipt(t)}
      </dd>
      <dd className={s.time}>{shortClock(t.at ?? sentAt)}</dd>
    </>
  );
}

const AgentLink = ({ project, taskId, title }: { project: ProjectKey; taskId: string; title: string | undefined }) => (
  <a href={toHash(panelRoute(project, { tab: "agents", agent: taskId }))} title={title ?? taskId}>
    {taskId}
  </a>
);

/** The log's foot: loads the next page as it scrolls into view, or says the log ends here. */
function End({ log }: { log: Log }) {
  const { hasOlder, loadOlder, loadingOlder, olderFailed, retryOlder } = log;
  useEffect(() => {
    if (hasOlder && !olderFailed) loadOlder();
  }, [hasOlder, olderFailed, loadOlder]);
  return (
    <div className={s.end}>
      {olderFailed && !loadingOlder ? (
        <Button variant="quiet" size="sm" onClick={retryOlder}>
          Couldn’t load older DMs. Retry
        </Button>
      ) : hasOlder || loadingOlder ? (
        <span role="status">
          <Text size="xs" tone="faint">
            Loading older DMs…
          </Text>
        </span>
      ) : (
        <Text size="xs" tone="faint">
          That’s every DM.
        </Text>
      )}
    </div>
  );
}
