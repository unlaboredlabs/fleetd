// The seam between "the team's Tailscale gateway" and where it runs. Everything else in fleetd (the settings row's
// tools, the nodes' dials and lookups, the hosted boxes) speaks to a `Gateway` and never to a tailscaled.
//
// - A self-hosted hub runs one (./local.ts): a userspace tailscaled under the hub's own home, its login state sealed in
//   the hub's database (`StateStore`), started with the hub.
// - A hub of several hosts (fleetd's cloud) puts its own `Gateway` in the hub's `tailnet` area (set under that
//   name before first use): one host holds a team's tailscaled at a time (a lease), the state moves between hosts
//   sealed (a `StateStore` of its own), and a call that lands on a host that doesn't hold it throws `NotHere`, which
//   the routes answer so that the node calls again (shared/tailnet.ts NOT_HERE) until one lands on the holder.
import type { Duplex } from "node:stream";
import type { TailnetState } from "../../shared/contracts.ts";

export type { TailnetState };

export interface Gateway {
  /** As it is now: what Settings shows. */
  state(): TailnetState;
  /** Starts it with no login if it has none, and resolves once Tailscale's sign-in page is known (`login`), or it
   * is connected already. */
  connect(): Promise<TailnetState>;
  /** Logs the device out of the tailnet and forgets its state: every box loses the tailnet at once. */
  disconnect(): Promise<TailnetState>;
  /** A TCP connection to `host` (a tailnet address or a MagicDNS name) on `port`, through the gateway. Throws `Off`
   * when it isn't connected, `NotHere` where another host holds it, else why the dial failed. */
  dial(host: string, port: number, signal?: AbortSignal): Promise<Duplex>;
  /** The gateway's own answer (a whole DNS message) to a lookup of `name` of DNS type `type` (1 A, 28 AAAA, 12 PTR…). */
  dns(name: string, type: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** Calls `fn` on every change of `state()`'s status or tailnet; the answer stops it. */
  onChange(fn: (s: TailnetState) => void): () => void;
  /** The tailnet's MagicDNS suffix while connected (`tailXXXX.ts.net`): what a box adds to its search domains. */
  suffix(): string | undefined;
  /** Starts it with the hub, from its sealed state if it has one. */
  start?(): Promise<void>;
  /** Ends it with the hub (the device stays registered: the next start brings it back). */
  stop(): Promise<void>;
}

/** The gateway's sealed login state, kept where the hub keeps its secrets. */
export interface StateStore {
  load(): Promise<Uint8Array | undefined>;
  save(state: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

/** The team has no Tailscale connection now. */
export class Off extends Error {
  constructor(message = "the team has no Tailscale connection: an admin connects it in Settings › Hub › Machines") {
    super(message);
  }
}

/** Another host than this one holds the team's gateway now. */
export class NotHere extends Error {
  constructor(message = "the team's Tailscale gateway is on another host") {
    super(message);
  }
}
