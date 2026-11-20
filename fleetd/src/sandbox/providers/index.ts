// Hosted sandboxes for agents: boat.dev, behind the one small interface fleetd needs from any provider (design
// `sandbox-per-agent-design` §6), so another can be added as one more client. A provider stays only where its boxes
// run everything a Linux machine runs, Android's emulator included, which needs KVM inside the box: E2B (no KVM in its
// Firecracker microVMs) and Daytona (its /dev/kvm can't be opened in its user-namespaced containers) were removed for
// that (D576). The node that owns a project's checkout creates one box per agent with the
// team's own key, starts `fleetd sandbox-guest` in it, reaches the guest's one private port as a byte stream, and
// destroys the box when the agent ends. The hub knows no provider; no machine joins it.
//
// What the interface leaves out on purpose: pause and stop (a box holding secrets is destroyed, never kept in provider
// storage; each kind is created so that a provider-side stop deletes it too), ports beyond the one, file writes, and
// any plugin. Secrets reach a box only at `start`, never at `create`: create parameters and
// templates are stored by the provider. Each client is plain HTTP against the provider's public API (no SDK, no CLI).
import { boat } from "./boat.ts";
import type { ClientOptions, Provider, ProviderAuth, ProviderId } from "./common.ts";

export * from "./common.ts";
export type { Duplex } from "./stream.ts";
export { ProviderError, type Reason } from "./http.ts";
export { hosted, hostedDockerfile, templateName, type HostedPins } from "./recipe.ts";
export { TESTED as CLAUDE_TESTED } from "../../node/runner/claude_pins.ts";

export function provider(id: ProviderId, auth: ProviderAuth, o: ClientOptions = {}): Provider {
  switch (id) {
    case "boat":
      return boat(auth, o);
  }
}
