// The bot of a project on screen (botState.ts), from the hub's state as it moves; undefined for no project, or outside
// a hub's screens. And whether its lead's turn just ended, for the open chat's bot to be done a moment, as the
// desktop's chat title is.
import { useContext, useEffect, useRef, useState } from "react";
import { botOf } from "../botState";
import type { BotState } from "../desktop";
import { HubContext } from "../hubContext";
import type { Key } from "../store";

export const useBot = (key: Key | undefined, done = false): BotState | undefined => {
  const hub = useContext(HubContext);
  return key === undefined || hub === null ? undefined : botOf(hub.state, key, done);
};

/** How long a bot stays done after its lead's turn ends, while its chat is open (the desktop's JUST_DONE_MS). */
export const JUST_DONE_MS = 8000;

/** The lead's turn, `working` a moment ago, ended under JUST_DONE_MS ago. */
export const useJustDone = (working: boolean): boolean => {
  const was = useRef(working);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const ended = was.current && !working;
    was.current = working;
    if (working) setDone(false);
    if (!ended) return;
    setDone(true);
    const timer = setTimeout(() => setDone(false), JUST_DONE_MS);
    return () => clearTimeout(timer);
  }, [working]);
  return done && !working;
};
