// The phone's network, as it changes (networkWatch.ts reports it): a move to another network, or back onto one, nudges
// the link (session.ts networkChanged), as a socket on the network left behind dies without a word and a link waiting
// out its backoff would sit there. Pure, so it is unit-tested.

/** What expo-network reports of the network: its kind, and whether it's up. */
export interface NetworkSeen {
  readonly type?: string | undefined;
  readonly isConnected?: boolean | undefined;
  readonly isInternetReachable?: boolean | undefined;
}

/**
 * Takes each network state as reported, the first being the one the app started on, and nudges when the phone is on
 * a network that differs from the one before and is up (none, or one with no internet, gives nothing to dial).
 */
export const networkNudges = (nudge: () => void): ((state: NetworkSeen) => void) => {
  let last: string | undefined;
  return (state) => {
    const now = `${state.type ?? "?"}/${String(state.isConnected)}/${String(state.isInternetReachable)}`;
    if (now === last) return;
    const first = last === undefined;
    last = now;
    if (!first && state.isConnected !== false && state.isInternetReachable !== false) nudge();
  };
};
