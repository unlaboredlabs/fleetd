// One DM on an agent's thread: a quiet hairline card, apart from the lead's Told rail and the agent's own steps. "From
// T2573" or "To T2577 · its title", the other agent's id a link to it, the words cut at three lines, and one receipt
// line saying what became of it (a line per recipient when it went to several). Read-only: nobody edits a DM.
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { Fragment } from "react";
import { Text, Truncate } from "../../ui";
import { shortClock } from "../chat/format";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import { cardReceipt, type AgentMessage, type AgentMessageTo } from "./model";
import s from "./dms.module.css";

export function DmCard({ dm, self, project }: { dm: AgentMessage; self: string; project: ProjectKey }) {
  const sent = dm.from.taskId === self;
  const peers: readonly { readonly taskId: string; readonly title?: string | undefined }[] = sent ? dm.to : [dm.from];
  const mine = dm.to.find((t) => t.taskId === self);
  const Arrow = sent ? ArrowUpRight : ArrowDownLeft;
  const only = peers.length === 1 ? peers[0] : undefined;
  return (
    <article className={s.card} data-dm={dm.id} aria-label={`${sent ? "DM to" : "DM from"} ${peers.map((p) => p.taskId).join(", ")}`}>
      <div className={s.head}>
        <span className={s.arrow}>
          <Arrow size={13} strokeWidth={2} aria-hidden />
        </span>
        <Text size="xs" tone="quiet">
          {sent ? "To" : "From"}
        </Text>
        <span className={s.peers}>
          {peers.map((p, i) => (
            <Fragment key={p.taskId}>
              {i > 0 ? ", " : null}
              <a className={s.peer} href={toHash(panelRoute(project, { tab: "agents", agent: p.taskId }))} title={p.title ?? p.taskId}>
                {p.taskId}
              </a>
            </Fragment>
          ))}
        </span>
        <span className={s.peerTitle}>
          {only?.title === undefined ? null : (
            <Truncate size="xs" tone="quiet" expand="none">
              {only.title}
            </Truncate>
          )}
        </span>
        <Text size="xs" tone="faint" tabular>
          {shortClock(dm.sentAt)}
        </Text>
      </div>
      <Truncate size="md" lines={3} expand="inline">
        {dm.text}
      </Truncate>
      <div className={s.foot}>
        {sent ? dm.to.map((t) => <Receipt key={t.taskId} t={t} who={dm.to.length > 1 ? t.taskId : undefined} received={false} />) : mine === undefined ? null : <Receipt t={mine} received />}
      </div>
    </article>
  );
}

function Receipt({ t, who, received }: { t: AgentMessageTo; who?: string | undefined; received: boolean }) {
  const guard = t.outcome === "woke" || t.outcome === "not_woken";
  return (
    <Text size="xs" tone={t.outcome === "refused" ? "danger" : guard ? "default" : "quiet"} strong={guard} data-outcome={t.outcome}>
      {`${who === undefined ? "" : `${who}: `}${cardReceipt(t, received, (iso) => shortClock(iso))}`}
    </Text>
  );
}
