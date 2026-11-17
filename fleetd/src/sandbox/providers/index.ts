// Hosted sandboxes for agents: boat.dev, E2B and Daytona, behind the one small interface fleetd needs from any of them
// (design `sandbox-per-agent-design` §6). The node that owns a project's checkout creates one box per agent with the
// team's own key, starts `fleetd sandbox-guest` in it, reaches the guest's one private port as a byte stream, and
// destroys the box when the agent ends. The hub knows no provider; no machine joins it.
//
// What the interface leaves out on purpose: pause and stop (a box holding secrets is destroyed, never kept in provider
// storage; each kind is created so that a provider-side stop deletes it too), ports beyond the one, file writes, and
// any fourth provider or plugin. Secrets reach a box only at `start`, never at `create`: create parameters and
// templates are stored by the provider. Each client is plain HTTP against the provider's public API (no SDK, no CLI).
//
// Nothing uses these clients yet: the hosted kind of the `Place` seam does, in a later step.
import { boat } from "./boat.ts";
import type { ClientOptions, Provider, ProviderAuth, ProviderId } from "./common.ts";
import { daytona } from "./daytona.ts";
import { e2b } from "./e2b.ts";

export * from "./common.ts";
export type { Duplex } from "./stream.ts";
export { ProviderError, type Reason } from "./http.ts";

export function provider(id: ProviderId, auth: ProviderAuth, o: ClientOptions = {}): Provider {
  switch (id) {
    case "boat":
      return boat(auth, o);
    case "e2b":
      return e2b(auth, o);
    case "daytona":
      return daytona(auth, o);
  }
}
