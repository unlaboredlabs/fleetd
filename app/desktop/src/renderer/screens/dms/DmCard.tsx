// One DM on an agent's thread: a quiet hairline card, apart from the lead's Told rail and the agent's own steps. "From
// <agent>" or "To <agent>", the other agent by its name, a chip that opens it, the words cut at three lines, and one receipt
// line saying what became of it (a line per recipient when it went to several). A note shows on its sender's thread as
// "To the bot", with no receipt to give. Read-only: nobody edits a DM.
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { Fragment } from "react";
import { RefText, Text, Truncate } from "../../ui";
import { shortClock } from "../chat/format";
import { RefChip } from "../refs/RefChip";
import type { ProjectKey } from "../shell/routes";
import { cardReceipt, cardReceiptFor, isNote, type AgentMessage, type AgentMessageTo } from "./model";
import s from "./dms.module.css";

export function DmCard({ dm, self, project }: { dm: AgentMessage; self: string; project: ProjectKey }) {
  const sent = dm.from.taskId === self;
  const peers: readonly { readonly taskId: string; readonly title?: string | undefined }[] = sent ? dm.to : [dm.from];
  const mine = dm.to.find((t) => t.taskId === self);
  const Arrow = sent ? ArrowUpRight : ArrowDownLeft;
  const note = isNote(dm);
  return (
    <article className={s.card} data-dm={dm.id} aria-label={note ? "Note to the bot" : `${sent ? "DM to" : "DM from"} ${peers.map((p) => p.title ?? "an agent").join(", ")}`}>
      <div className={s.head}>
        <span className={s.arrow}>
          <Arrow size={13} strokeWidth={2} aria-hidden />
        </span>
        <Text size="xs" tone="quiet">
          {sent ? "To" : "From"}
        </Text>
        <span className={s.peers}>
          {note ? "the bot" : null}
          {peers.map((p, i) => (
            <Fragment key={p.taskId}>
              {i > 0 ? ", " : null}
              <RefChip of={{ id: p.taskId, kind: "agent", opens: false }} title={p.title} project={project} />
            </Fragment>
          ))}
        </span>
        <span className={s.peerTitle} />
        <Text size="xs" tone="faint" tabular>
          {shortClock(dm.sentAt)}
        </Text>
      </div>
      <Truncate size="md" lines={3} expand="inline">
        {dm.text}
      </Truncate>
      <div className={s.foot}>
        {note ? (
          <Text size="xs" tone="quiet">
            Note to the bot: its agents read it in their agent list. Nobody was woken.
          </Text>
        ) : sent ? dm.to.map((t) => <Receipt key={t.taskId} t={t} several={dm.to.length > 1} received={false} />) : mine === undefined ? null : <Receipt t={mine} received />}
      </div>
    </article>
  );
}

function Receipt({ t, several = false, received }: { t: AgentMessageTo; several?: boolean; received: boolean }) {
  const fmt = (iso: string) => shortClock(iso);
  const guard = t.outcome === "woke" || t.outcome === "not_woken";
  return (
    <Text size="xs" tone={t.outcome === "refused" ? "danger" : guard ? "default" : "quiet"} strong={guard} data-outcome={t.outcome}>
      <RefText text={several ? cardReceiptFor(t, fmt) : cardReceipt(t, received, fmt)} />
    </Text>
  );
}
