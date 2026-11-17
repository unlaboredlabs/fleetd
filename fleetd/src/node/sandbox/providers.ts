// A stand-in for the hosted providers' clients (fleetd/src/sandbox/providers, T4041), with the same exports, until
// they land: then this file only re-exports them. Every provider's list refuses, saying this build has no client yet,
// so Settings' Test says so in plain words rather than pass a key it never asked about.
import type { KnownSandboxProvider } from "../../shared/contracts.ts";
import { NAMES } from "../../shared/sandbox.ts";

export type ProviderId = KnownSandboxProvider;
export type ProviderAuth = { key: string; domain?: string };
export type ProviderErrorReason = "invalid_key" | "limit" | "billing" | "unreachable" | "failed";

export class ProviderError extends Error {
  constructor(
    readonly reason: ProviderErrorReason,
    message: string,
  ) {
    super(message);
  }
}

export interface Provider {
  list(o?: { signal?: AbortSignal }): Promise<{ id: string; labels?: Record<string, string> }[]>;
}

export function provider(id: ProviderId, _auth: ProviderAuth, _o?: { fetch?: typeof fetch; signal?: AbortSignal }): Provider {
  return {
    list: () => Promise.reject(new ProviderError("failed", `This fleetd has no ${NAMES[id]} client yet: update fleetd on this machine, then test again.`)),
  };
}
