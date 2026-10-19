// Settings' way to the hub until E1's store and Query hooks land: typed calls over window.fleetd, and ONE shared
// frame subscription for the connection phase and the prompt events (each subscribe makes main resync, so screens
// must not open their own). When the store lands, useHubPhase/usePromptEvents become its selectors.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { HubError, HubFrame, HubState } from "../../../shared/hub";
import { PROMPT_EVENTS } from "./contracts";

export class CallFailed extends Error {
  constructor(readonly error: HubError) {
    super(error.fix ? `${error.message} ${error.fix}` : error.message);
  }
}

export async function call<Out>(tool: string, input: object): Promise<Out> {
  const outcome = await window.fleetd.hub.call(tool, input);
  if (!outcome.ok) throw new CallFailed(outcome.error);
  // The hub validated the output against the same contract this file mirrors.
  return outcome.output as Out;
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

let phase: HubState = { phase: "connecting", hub: "", attempt: 0 };
let promptSeq = 0;
const listeners = new Set<() => void>();
let started = false;

function start() {
  if (started) return;
  started = true;
  void window.fleetd.hub.state().then((s) => {
    phase = s;
    for (const l of listeners) l();
  });
  window.fleetd.hub.subscribe((frame: HubFrame) => {
    if (frame.t === "state") phase = frame.state;
    else if (frame.t === "event" && PROMPT_EVENTS.has(frame.event.type)) promptSeq += 1;
    // A fresh snapshot after a reconnect may follow edits made elsewhere while away.
    else if (frame.t === "snapshot") promptSeq += 1;
    else return;
    for (const l of listeners) l();
  });
}

function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** For code outside React (the palette's prompt source): called on every phase change and prompt event. */
export const onHubChange = subscribe;
export const hubPhase = (): HubState => phase;

export function useHubPhase(): HubState {
  return useSyncExternalStore(subscribe, () => phase);
}

/** Bumps whenever a prompt was saved or reset anywhere (another device, the CLI) or the connection resynced. */
export function usePromptEvents(): number {
  return useSyncExternalStore(subscribe, () => promptSeq);
}

export type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed"; message: string };

/**
 * A call's answer, refetched when `key` changes. An answer for an older key is dropped, so a slow reply for the
 * previous project or prompt never lands on the one now shown. A refetch for the same key (a reload, or a new
 * `version` after an event) keeps the last answer on screen until the new one arrives.
 */
export function useCall<T>(key: string | null, run: () => Promise<T>, version = 0): [Load<T>, () => void] {
  const [load, setLoad] = useState<{ key: string | null; load: Load<T> }>({ key, load: { state: "loading" } });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    run().then(
      (value) => live && setLoad({ key, load: { state: "ready", value } }),
      (e: unknown) => live && setLoad({ key, load: { state: "failed", message: errorText(e) } }),
    );
    return () => {
      live = false;
    };
    // `run` closes over the same inputs as `key`; the key is the identity of the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce, version]);
  const shown: Load<T> = load.key === key ? load.load : { state: "loading" };
  return [shown, () => setNonce((n) => n + 1)];
}
