// What usage_status reads from a machine's T3: the fleetd Claude instance's login kind and where T3 writes its trace.
// Both come from T3's `server.getConfig`; credentials and env var values are never read, only the names.
import type { LoginKind, MachineId } from "@fleetd/contracts";
import type { ProviderInstanceConfig, ServerProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ExecutorError } from "../executor/Executors.ts";

export interface UsageReading {
  readonly login: LoginKind;
  /** T3's logs directory, which holds `server.trace.ndjson`. */
  readonly logsDir?: string;
  /** T3 runs on the hub's own machine (a loopback URL), so its logs directory is the hub's to read. */
  readonly local: boolean;
}

export class UsageSource extends Context.Service<
  UsageSource,
  { readonly read: (machineId: MachineId) => Effect.Effect<UsageReading, ExecutorError> }
>()("fleetd/usage/UsageSource") {}

const BASE_URL_VARS = ["ANTHROPIC_BASE_URL"];
const API_KEY_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/** A custom base URL wins over a key, which wins over a signed-in subscription. */
export const loginKindOf = (provider: ServerProvider | undefined, config: ProviderInstanceConfig | undefined): LoginKind => {
  const names = new Set((config?.environment ?? []).map((v) => v.name));
  if (BASE_URL_VARS.some((n) => names.has(n))) return "custom_base_url";
  if (provider?.auth.type === "apiKey" || API_KEY_VARS.some((n) => names.has(n))) return "api_key";
  if (provider?.auth.status === "authenticated") return "subscription";
  return "unknown";
};

export const isLoopbackUrl = (url: string) => {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "[::1]" || host === "::1" || host.startsWith("127.");
  } catch {
    return false;
  }
};
