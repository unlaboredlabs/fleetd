// "Worked for 27s" and "Done in 3m 10s · 3 agents" beside the reply a lead turn ended with, and what pressing it opens:
// that turn's list (TurnBody.tsx). Loaded with the first reply that has a stamp (Bubble.tsx), so the chat's first load
// stays as it was. The reply that closed an order says so from the message itself (ChatMessage.closed, the hub's), so
// it reads the same after a reload; "Worked for…" is the latest turn's, from the events.
import { useState, type ReactNode } from "react";
import type { ChatClosed } from "../../../shared/contracts";
import { useData } from "../../src/data/react";
import { projectKey } from "../../src/data/store";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui";
import type { ProjectKey } from "../shell/routes";
import { leadLastTurnSince, leadLastTurnUntil } from "./activity";
import { TurnBody } from "./TurnBody";
import s from "./turn.module.css";

/**
 * The stamp, `worked` its words. Without `time`: they go quietly beside the reply. With it: a quiet button among the
 * reply's actions that opens its turn's list, in the reply's time's place: the time keeps the room (unseen), so the
 * reply's bubble keeps its width and nothing moves as the actions show.
 */
export default function TurnStamp({ worked, project, time, closed }: { worked: string; project: ProjectKey; time?: ReactNode; closed?: ChatClosed | undefined }) {
  const [open, setOpen] = useState(false);
  const order = closed?.workstreamId;
  // The turn the stamp is of: the run that closed the order, as the hub kept it; else the lead's latest that is over,
  // as the reply's stamp is (model.ts).
  const lastSince = useData((d) => leadLastTurnSince(d, projectKey(project)));
  const lastUntil = useData((d) => leadLastTurnUntil(d, projectKey(project)));
  const since = closed !== undefined ? Date.parse(closed.since) : lastSince;
  const until = closed !== undefined ? Date.parse(closed.until) : lastUntil;
  if (time === undefined || since === undefined || until === undefined) return <>{worked}</>;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className={s.spot}>
        <span className={s.room} aria-hidden>
          {time}
        </span>
        <PopoverTrigger asChild>
          <button type="button" className={s.stamp} aria-label={`${worked}: what it did`}>
            {worked}
          </button>
        </PopoverTrigger>
      </span>
      <PopoverContent side="bottom" align="start" className={s.pop} aria-label="What this turn did">
        <TurnBody turn={{ since, until }} order={order} project={project} onOpen={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
