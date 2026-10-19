// The question cards outside the inbox: the board's Needs you (under its composer, the first few with "+N more")
// and an order's own asks above its follow-up composer. Same card, same state as the panel.
import type { ReactNode } from "react";
import { display } from "../../../shared/shortcuts";
import { Button, Text } from "../../ui";
import { useData } from "../../src/data/react";
import { selectInbox, selectOpenAsksByOrder } from "../../src/data/selectors";
import { needsYou } from "./model";
import { inboxHash } from "./needsYouSource";
import { QuestionCard } from "./QuestionCard";
import { useInboxUi } from "./store";
import s from "./NeedsYouStrip.module.css";

const openInbox = (askId?: string): void => {
  const hash = window.location.hash;
  if (askId !== undefined) window.location.hash = inboxHash(hash, askId);
  else window.location.hash = `#${hash.replace(/^#/u, "").split("?")[0] || "/board"}?inbox`;
};

export interface NeedsYouStripProps {
  /** One order's asks (the order view). */
  workstreamId?: string | undefined;
  /** One project's asks, "machineId/projectId" (the board filtered from the sidebar). */
  project?: string | undefined;
  /** Show this many cards, then "+N more" into the inbox. */
  limit?: number | undefined;
}

/** Nothing while loading or when nothing needs you; the cards otherwise. */
export function NeedsYouStrip({ workstreamId, project, limit }: NeedsYouStripProps) {
  const open = useData(selectInbox);
  const ui = useInboxUi();
  const asks = needsYou(open, ui, { workstreamId, project });
  if (asks === undefined || asks.length === 0) return null;
  const total = open?.length ?? asks.length;
  const shown = limit === undefined ? asks : asks.slice(0, limit);
  const more = asks.length - shown.length;
  const key = display("inbox.toggle", window.fleetd.platform);
  return (
    <section className={s.strip} aria-label="Needs you">
      <div className={s.head}>
        <Text size="xs" tone="quiet" strong>
          {workstreamId === undefined ? `Needs you ${String(asks.length)}` : `Needs you ${String(asks.length)} of ${String(total)}`}
        </Text>
        <Button variant="quiet" shortcut={key} onClick={() => openInbox()}>
          {more > 0 ? `${String(more)} more in the inbox` : "Open the inbox"}
        </Button>
      </div>
      {/* The host's fixed area (under the board's composer, above the order's) can't grow without pushing the rest
          off screen, so the cards scroll within at most about half the window. */}
      <div className={s.cards}>
        {shown.map((ask) => (
          <QuestionCard key={ask.askId} ask={ask} />
        ))}
      </div>
    </section>
  );
}

/** Wraps a board row's "needs you" chip: a click opens the inbox on that order's first open ask. */
export function OpenAsksButton({ workstreamId, children }: { workstreamId: string; children: ReactNode }) {
  const first = useData((d) => selectOpenAsksByOrder(d)[workstreamId]?.[0]?.askId);
  return (
    <button
      type="button"
      className={s.chipButton}
      aria-label="Answer in the inbox"
      onClick={(e) => {
        e.stopPropagation();
        openInbox(first);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {children}
    </button>
  );
}
