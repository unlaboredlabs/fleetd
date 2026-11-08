// The phone's network watched with expo-network (network.ts says when it nudges). The module is native: a bundle on a
// build made before it (which the runtime version's fingerprint should never let happen) watches nothing, and the link
// finds a dead socket by its silence, as before.
import { requireOptionalNativeModule } from "expo";
import { networkNudges } from "./network";

export const watchNetwork = (nudge: () => void): (() => void) => {
  if (requireOptionalNativeModule("ExpoNetwork") === null) return () => undefined;
  // Required here, not imported: the module asks for its native side as it loads.
  const Network = require("expo-network") as typeof import("expo-network");
  const seen = networkNudges(nudge);
  void Network.getNetworkStateAsync().then(seen, () => undefined);
  const sub = Network.addNetworkStateListener(seen);
  return () => sub.remove();
};
