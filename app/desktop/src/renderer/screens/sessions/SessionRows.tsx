// A project's screens as the Agents tab lists them (agents/AgentsPane.tsx), under its agents: the browsers and devices
// its agents and you have open, those asking you to take over first, then the live ones, and the ones that ended under
// a fold. One row each: what it is for and, under it, its state in a word (asking, why). Whose it is, the site it is on
// and how long it ran are in the row's hover and on its own view. A row opens the screen in the list's place, live
// while it runs (SessionView), its replay once it has ended. Your waits for a slot on a full machine show until their
// screen opens.
import type { ComponentProps } from "react";
import { Button, StateGlyph, Text, Tooltip, Truncate, cx, toast, useArrived } from "../../ui";
import { useData, useDataLayer } from "../../src/data/react";
import { parseMs } from "../live/format";
import { agoText } from "../projects/machineText";
import { panelRoute, toHash } from "../shell/routes";
import { durationOf, fmtDuration, glyphOf, isLive, siteOf, STATE_TONE, STATE_WORD, waitLine, type BrowserSession, type ScreenWaiting } from "./model";
import s from "./sessions.module.css";

/**
 * Your screen on its way: what and where, then your place in line (with Cancel), the PR's build going in, or why it
 * didn't open (with Clear).
 */
export function WaitRow({ wait }: { wait: ScreenWaiting }) {
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

/** Whose it is, the site it is on and how long it ran: the row's hover. */
export const sessionDetail = (x: BrowserSession, now: number): string => [x.agent.title, siteOf(x), fmtDuration(durationOf(x, now))].filter((part) => part !== "").join(" · ");

/**
 * Its glyph and what it is for; under it its state in a word, or how long ago it ended; asking for you, the agent's
 * reason instead, in the warning colour. A link, so it opens with the keyboard and keeps history. The rest of the props
 * are the list's (a right-click menu's), spread on the link.
 */
export function SessionRow({ list, session: x, now, ...rest }: { list: string; session: BrowserSession; now: number } & ComponentProps<"a">) {
  const fresh = useArrived(list, x.id);
  const href = toHash(panelRoute(x.projectRef, { tab: "sessions", session: x.id }));
  const ended = parseMs(x.endedAt);
  const asking = x.state === "asking";
  return (
    <Tooltip content={sessionDetail(x, now)} side="left">
      <a {...rest} className={cx(s.row, fresh && s.arrive, !isLive(x) && s.ended)} href={href} data-state={x.state} data-session={x.id}>
        <span className={s.glyph}>
          <StateGlyph state={glyphOf(x.state)} label={STATE_WORD[x.state]} phase={x.id.length % 4} settled={!fresh} />
        </span>
        <span className={s.purpose}>
          <Truncate size="sm" expand="none">
            {x.purpose}
          </Truncate>
        </span>
        <span className={s.meta}>
          {asking && x.handoff !== undefined ? (
            <Truncate size="xs" tone="warning" lines={2} expand="none">
              {x.handoff.reason}
            </Truncate>
          ) : (
            <Text size="xs" tone={isLive(x) ? STATE_TONE[x.state] : "quiet"}>
              {isLive(x) || ended === undefined ? STATE_WORD[x.state] : x.state === "ended" ? agoText(now - ended) : `${STATE_WORD[x.state]} · ${agoText(now - ended)}`}
            </Text>
          )}
        </span>
      </a>
    </Tooltip>
  );
}
