// The tagged chat's pieces (lens/tags.ts lays them out): the quiet line over a run naming its order and whom it is
// for, a closed order's fold, and the lens's capsule beside the chat's pill.
import { ChevronRight, X } from "lucide-react";
import type { ChatAbout, ChatFold } from "../../../../shared/contracts";
import { Capsule, cx, Tooltip } from "../../../ui";
import { useBubbleActions } from "../actions";
import type { Tag } from "./tags";
import l from "./lens.module.css";

/**
 * Over a run: another person's name or whom the lead writes to, then the order, which opens a lens on it. `by`: the
 * writer's name (another person's), when the run shows it. `inner`: over a bubble inside a message (one about several
 * orders), set off from the bubble above as a run is.
 */
export function TagLine({ by, tag, mine, from, inner }: { by?: string | undefined; tag: Tag; mine: boolean; from: string; inner?: boolean }) {
  const tags = useBubbleActions()?.tags;
  const who = by ?? (tag.to === undefined ? undefined : `to ${tag.to}`);
  const order = tag.order;
  return (
    <div className={cx(l.tag, mine && l.mine, inner === true && l.inner)} data-tag="">
      {who !== undefined ? <span className={l.who}>{who}</span> : null}
      {order !== undefined ? (
        <button type="button" className={l.order} onClick={() => tags?.look(order, from)} aria-label={`Only ${order.title}`}>
          {order.title}
        </button>
      ) : null}
    </div>
  );
}

/** A closed order's messages as one line where its landing was said: a dot for how it ended, its name, how many. */
export function FoldLine({ fold, open }: { fold: ChatFold; open: boolean }) {
  const tags = useBubbleActions()?.tags;
  const ended = fold.state === "stopped" ? "Stopped" : "Done";
  return (
    <div className={l.foldRow} data-entry="fold">
      <button type="button" className={l.fold} aria-expanded={open} onClick={() => tags?.toggleFold(fold.workstreamId)}>
        <span className={cx(l.dot, fold.state === "stopped" && l.stopped)} role="img" aria-label={ended} />
        <span className={l.foldTitle}>{fold.title}</span>
        <span className={l.count}>{fold.count === 1 ? "1 message" : `${String(fold.count)} messages`}</span>
        <ChevronRight className={l.chevron} aria-hidden />
      </button>
    </div>
  );
}

/** The lens's capsule, beside the chat's pill: the order, what its work is at, and the way back to the whole chat. */
export function LensCapsule({ about, phase, onClose }: { about: ChatAbout; phase: string | undefined; onClose: () => void }) {
  return (
    <Capsule className={l.lens}>
      <span className={l.lensTitle}>{about.title}</span>
      {phase === undefined ? null : <span className={l.lensPhase}>{phase}</span>}
      <Tooltip content="Whole chat · Esc" side="bottom">
        <button type="button" className={l.close} aria-label="Show the whole chat" onClick={onClose}>
          <X aria-hidden />
        </button>
      </Tooltip>
    </Capsule>
  );
}
