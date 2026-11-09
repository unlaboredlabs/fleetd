// The bot of a project on screen (botState.ts), from the hub's state as it moves; undefined for no project, or outside
// a hub's screens.
import { useContext } from "react";
import { botOf } from "../botState";
import type { BotState } from "../desktop";
import { HubContext } from "../hubContext";
import type { Key } from "../store";

export const useBot = (key: Key | undefined, done = false): BotState | undefined => {
  const hub = useContext(HubContext);
  return key === undefined || hub === null ? undefined : botOf(hub.state, key, done);
};
