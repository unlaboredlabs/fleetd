// The team's own hosted sandbox accounts (W688), without the hub or the node: the providers in the one fixed order
// agents go to them, the limit's bounds, and what a node's check of a key found. The hub keeps the keys (hub/sandbox)
// and its slot board places agents by count (hub/slots/board.ts); a node checks a key with the provider's client and
// makes one box per agent there (node/sandbox, node/place/hosted.ts).
import type { KnownSandboxCheckReason, KnownSandboxProvider } from "./contracts.ts";

/** The capability a node lists when it creates agents' sandboxes, so the hub tests keys and sends limits there. */
export const CAP_SANDBOX = "sandbox";

/**
 * Every provider, in the placement order: the order agents go to the connected ones once a machine's own slots are
 * full, which Settings shows. (sandbox/providers' own PROVIDERS is only the clients' list, in no such order.)
 */
export const ORDER: readonly KnownSandboxProvider[] = ["e2b", "boat", "daytona"];

export const NAMES: Readonly<Record<KnownSandboxProvider, string>> = { e2b: "E2B", boat: "boat.dev", daytona: "Daytona" };

export const isProvider = (p: string): p is KnownSandboxProvider => (ORDER as readonly string[]).includes(p);

/** A provider's limit when none was set at connect. */
export const DEFAULT_LIMIT = 5;
/** The most agents one provider's limit allows: E2B Pro's own ceiling is a little above it. */
export const MAX_LIMIT = 500;

/** How long Settings' Test of a key may take on a machine (the provider's list). */
export const CHECK_WAIT = 30_000;

export const REASONS: readonly KnownSandboxCheckReason[] = ["invalid_key", "limit", "billing", "unreachable", "failed"];

/** A check's reason as one this build knows; anything else is `failed`. */
export const reasonOf = (r: unknown): KnownSandboxCheckReason => (REASONS.includes(r as KnownSandboxCheckReason) ? (r as KnownSandboxCheckReason) : "failed");

/** One connected provider's limit, as the hub sends it to the team's machines (`sandbox_limits`), in ORDER. */
export type Limit = { provider: KnownSandboxProvider; max: number };

/** A domain as typed (`https://e2b.example.com/`): its host and port, lower case; null when it isn't one. */
export function domainOf(typed: string): string | null {
  const t = typed.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (t === "") return null;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/.test(t) && t.length <= 253 ? t : null;
}
