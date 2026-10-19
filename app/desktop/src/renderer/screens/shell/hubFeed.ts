// The shell's one subscription to the hub frames main forwards: the connection state for the frame and the events
// the notifier reads. E1's store reads the same frames for the screens' data.
import { useSyncExternalStore } from "react";
import type { HubEvent, HubFrame, HubState } from "../../../shared/hub";

let state: HubState | null = null;
const stateListeners = new Set<() => void>();
const eventListeners = new Set<(event: HubEvent) => void>();
let unsubscribe: (() => void) | null = null;

const onFrame = (frame: HubFrame): void => {
  if (frame.t === "state") {
    state = frame.state;
    for (const listener of stateListeners) listener();
  } else if (frame.t === "event") {
    for (const listener of eventListeners) listener(frame.event);
  }
};

/** Subscribes while anything listens, so a page with no shell (the QA gallery) costs main nothing. */
const retain = (): (() => void) => {
  unsubscribe ??= window.fleetd.hub.subscribe(onFrame);
  return () => {
    if (stateListeners.size === 0 && eventListeners.size === 0) {
      unsubscribe?.();
      unsubscribe = null;
    }
  };
};

const subscribeState = (listener: () => void): (() => void) => {
  stateListeners.add(listener);
  const release = retain();
  return () => {
    stateListeners.delete(listener);
    release();
  };
};

/** Null until main has said; the frame shows nothing connection-specific until then. */
export const useHubState = (): HubState | null => useSyncExternalStore(subscribeState, () => state);

export const onHubEvent = (listener: (event: HubEvent) => void): (() => void) => {
  eventListeners.add(listener);
  const release = retain();
  return () => {
    eventListeners.delete(listener);
    release();
  };
};
