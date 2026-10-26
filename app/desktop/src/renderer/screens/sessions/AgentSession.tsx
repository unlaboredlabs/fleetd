// One agent's browser, in its own view (agents/AgentWork): under what it is doing now (which says why, when it asks
// you to take over), the session it has open, if any, and the site it is on, with Watch; asking, Take over, which
// opens the session with the page yours.
import { Hand } from "lucide-react";
import { Button, StateGlyph, Text } from "../../ui";
import { navigate } from "../shell/navigation";
import { panelRoute, type ProjectKey } from "../shell/routes";
import { glyphOf, isLive, siteOf, STATE_WORD } from "./model";
import { takeOver, useBrowserSessions } from "./preview";
import s from "./sessions.module.css";

export function AgentSession({ project, laneId }: { project: ProjectKey; laneId: string }) {
  const session = useBrowserSessions(project).find((x) => x.agent.laneId === laneId && isLive(x));
  if (session === undefined) return null;
  const open = () => navigate(panelRoute(project, { tab: "sessions", session: session.id }));
  const asking = session.state === "asking";
  return (
    <div className={s.agentSession} data-state={session.state}>
      <StateGlyph state={glyphOf(session.state)} label={STATE_WORD[session.state]} size="sm" />
      <span className={s.agentSessionWords}>
        <Text size="xs" tone="quiet">
          In a browser on
        </Text>
        <span className={s.site}>{siteOf(session)}</span>
      </span>
      {asking ? (
        <Button
          variant="primary"
          size="sm"
          icon={<Hand aria-hidden />}
          onClick={() => {
            takeOver(session.id);
            open();
          }}
        >
          Take over
        </Button>
      ) : (
        <Button variant="secondary" size="sm" onClick={open}>
          Watch
        </Button>
      )}
    </div>
  );
}
