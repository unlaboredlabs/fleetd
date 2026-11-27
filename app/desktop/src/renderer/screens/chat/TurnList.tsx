// "Worked for 27s" and "Done in 3m 10s · 3 agents" beside the reply a lead turn ended with, and what pressing it opens:
// that turn's list (TurnBody.tsx). Loaded with the first reply that has a stamp (Bubble.tsx), so the chat's first load
// stays as it was: until then the stamp reads "Worked for…", as it does while the order it closed is read.
import { useState, type ReactNode } from "react";
import { turnStamp } from "../../../shared/stamp";
import { useData, useToolQuery } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui";
import type { ProjectKey } from "../shell/routes";
import { leadLastTurnSince, leadLastTurnUntil } from "./activity";
import { TurnBody } from "./TurnBody";
import { closedOrderId, closedOrderStamp, leadLastTurnClosed } from "./turnDone";
import s from "./turn.module.css";

/**
 * The stamp's words: on the reply that closes an order, the order's whole time and its agents (its start to the
 * workstream.done inside the turn, order_get's agents), else `worked`, the turn's own time. And the order it closed.
 */
const useTurnStamp = (project: ProjectKey, worked: string): { readonly text: string; readonly order?: string | undefined } => {
  const closed = useData((d) => leadLastTurnClosed(d, projectKey(project)));
  const order = closedOrderId(closed);
  const read = useToolQuery("order_get", { workstreamId: order ?? "" }, { enabled: order !== undefined }).data;
  const stamp = closedOrderStamp(closed, read);
  return stamp === undefined ? { text: worked } : { text: turnStamp({ ms: 0, order: stamp }), order };
};

/**
 * The stamp. Without `time`: its quiet words beside the reply. With it: a quiet button among the reply's actions that
 * opens its turn's list, in the reply's time's place: the time keeps the room (unseen), so the reply's bubble keeps its
 * width and nothing moves as the actions show.
 */
export default function TurnStamp({ worked, project, time }: { worked: string; project: ProjectKey; time?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { text, order } = useTurnStamp(project, worked);
  // The turn the stamp is of: the lead's latest that is over, as the reply's stamp is (model.ts).
  const since = useData((d) => leadLastTurnSince(d, projectKey(project)));
  const until = useData((d) => leadLastTurnUntil(d, projectKey(project)));
  if (time === undefined || since === undefined || until === undefined) return <>{text}</>;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className={s.spot}>
        <span className={s.room} aria-hidden>
          {time}
        </span>
        <PopoverTrigger asChild>
          <button type="button" className={s.stamp} aria-label={`${text}: what it did`}>
            {text}
          </button>
        </PopoverTrigger>
      </span>
      <PopoverContent side="bottom" align="start" className={s.pop} aria-label="What this turn did">
        <TurnBody turn={{ since, until }} order={order} project={project} onOpen={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
