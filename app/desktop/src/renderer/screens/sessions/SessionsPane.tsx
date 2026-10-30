// The panel's browser sessions, in the Agents section beside the agents that use them: those asking you to take over
// first, then the live ones, then the recent ones that ended. One row each: what it is for, and under it its state in
// words, its agent (or the person who opened it), the site it is on and how long it has run. A row opens the session in
// the list's place, live while it runs (SessionView), its replay once it has ended. At the top, New screen opens one of
// your own (NewScreen), and your waits for a slot on a full machine show until their screen opens.
import { useMemo } from "react";
import { Button, EmptyState, StateGlyph, Text, Truncate, cx, toast, useArrivals, useArrived } from "../../ui";
import { useData, useDataLayer } from "../../src/data/react";
import { useNow } from "../live/clock";
import { parseMs } from "../live/format";
import { agoText } from "../projects/machineText";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";
import { durationOf, fmtDuration, glyphOf, isLive, sessionGroups, siteOf, STATE_TONE, STATE_WORD, waitLine, type BrowserSession, type ScreenWaiting } from "./model";
import { useScreenWaits, useSessions } from "./hub";
import { NewScreenButton } from "./NewScreen";
import { SessionView } from "./SessionView";
import s from "./sessions.module.css";

export function SessionsPane({ project, session }: { project: ProjectKey; session: string | null }) {
  if (session !== null) return <SessionView key={session} project={project} id={session} />;
  return <SessionList project={project} />;
}

function SessionList({ project }: { project: ProjectKey }) {
  const sessions = useSessions(project);
  const groups = useMemo(() => sessionGroups(sessions), [sessions]);
  const live = sessions.some(isLive);
  // Durations of live sessions count up with the app's one clock; the ended ones say how long ago, by the minute.
  const now = useNow(true, live ? undefined : 60_000);
  const list = `sessions:${project.machineId}/${project.projectId}`;
  useArrivals(list, sessions.map((x) => x.id));

  const waits = useScreenWaits(project);
  return (
    <div className={s.pane} data-screen="sessions">
      <div className={s.top}>
        <NewScreenButton project={project} />
      </div>
      {waits.length === 0 ? null : (
        <section className={s.waits} aria-label="Your screens on their way">
          {waits.map((w) => (
            <WaitRow key={w.id} wait={w} />
          ))}
        </section>
      )}
      {sessions.length === 0 ? (
        waits.length > 0 ? null : (
          <EmptyState title="No screens yet">When an agent opens a browser or a device, or you open one with New screen, it shows here: live while it runs, then its recording.</EmptyState>
        )
      ) : (
        <>
          <div className={s.list}>
            {groups.map((g) => (
              <section key={g.group} aria-label={g.title}>
                <span className={s.group} data-group={g.group}>
                  <Text size="xs" tone={g.group === "asking" ? "warning" : "quiet"} strong>
                    {g.title}
                  </Text>
                  <Text size="xs" tone="faint" tabular>
                    {String(g.sessions.length)}
                  </Text>
                </span>
                {g.sessions.map((x) => (
                  <SessionRow key={x.id} list={list} session={x} now={now} />
                ))}
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Your screen on its way: what and where, then your place in line (with Cancel), the PR's build going in, or why it
 * didn't open (with Clear).
 */
function WaitRow({ wait }: { wait: ScreenWaiting }) {
  const layer = useDataLayer();
  const machine = useData((d) => d.machines[wait.machineId]?.name ?? wait.machineId);
  const failed = wait.stage === "failed";
  const cancel = async () => {
    const out = await layer.call("screen_end", { waitId: wait.id });
    if (!out.ok) toast({ title: failed ? "Couldn’t clear it" : "Couldn’t cancel the wait", description: out.error.message, key: `wait:${wait.id}` });
    void layer.queryClient.invalidateQueries({ queryKey: ["call", "browser_sessions"] });
  };
  const line = waitLine(wait, machine);
  const opening = wait.stage === "starting" || wait.stage === "installing";
  return (
    <div className={s.wait} data-wait={wait.id} data-stage={wait.stage}>
      <span className={s.glyph}>
        <StateGlyph state={failed ? "failed" : opening ? "working" : "queued"} label={failed ? "didn’t open" : opening ? "opening" : "waiting for a slot"} phase={2} />
      </span>
      <span className={s.purpose}>
        <Truncate size="sm" expand="none">
          {line.title}
        </Truncate>
      </span>
      {opening ? null : (
        <Button variant="quiet" size="sm" className={s.waitCancel} onClick={() => void cancel()}>
          {failed ? "Clear" : "Cancel"}
        </Button>
      )}
      <span className={s.meta}>
        <Text size="xs" tone={failed ? "danger" : "quiet"}>
          {line.place}
        </Text>
      </span>
    </div>
  );
}

/**
 * Its glyph, what it is for; under it its state in words, its agent, the site and how long it ran (an ended one, how
 * long ago too). Asking for you, the agent's reason follows in the warning colour. A link, so it opens with the
 * keyboard and keeps history.
 */
function SessionRow({ list, session: x, now }: { list: string; session: BrowserSession; now: number }) {
  const fresh = useArrived(list, x.id);
  const href = toHash(panelRoute(x.projectRef, { tab: "sessions", session: x.id }));
  const ended = parseMs(x.endedAt);
  return (
    <a className={cx(s.row, fresh && s.arrive, !isLive(x) && s.ended)} href={href} data-state={x.state}>
      <span className={s.glyph}>
        <StateGlyph state={glyphOf(x.state)} label={STATE_WORD[x.state]} phase={x.id.length % 4} settled={!fresh} />
      </span>
      <span className={s.purpose}>
        <Truncate size="sm" expand="none">
          {x.purpose}
        </Truncate>
      </span>
      <span className={s.meta}>
        <span className={s.word}>
          <Text size="xs" tone={STATE_TONE[x.state]} strong={x.state === "asking" || x.state === "yours"}>
            {STATE_WORD[x.state]}
          </Text>
        </span>
        <span className={s.agent}>
          <Truncate size="xs" tone="quiet" expand="none">
            {x.agent.title}
          </Truncate>
        </span>
        {siteOf(x) === "" ? null : <span className={s.site}>{siteOf(x)}</span>}
        <span className={s.word}>
          <Text size="xs" tone="faint" tabular>
            {ended === undefined ? fmtDuration(durationOf(x, now)) : `${fmtDuration(durationOf(x, now))} · ${agoText(now - ended)}`}
          </Text>
        </span>
      </span>
      {x.state === "asking" && x.handoff !== undefined ? (
        <span className={s.reason}>
          <Truncate size="xs" tone="warning" lines={2} expand="none">
            {x.handoff.reason}
          </Truncate>
        </span>
      ) : null}
    </a>
  );
}
