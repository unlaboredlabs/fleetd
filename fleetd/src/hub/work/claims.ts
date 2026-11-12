// A claim's life without the database (index.ts keeps the claims): how long it lasts, how long an expired one shows,
// a claim as it ends, and whether a Change's repo is the one a key names.
import type { Claim, ClaimState } from "../../shared/contracts.ts";
import { isoMs } from "../store/time.ts";
import * as view from "./view.ts";

/** A claim lasts this long from its last renewal (fleetd-contracts work.rs). */
export const CLAIM_TTL_MS = 12 * 3_600_000;
/** An expired claim stays in the view, as weak, this long. */
export const EXPIRED_SHOWN_MS = 24 * 3_600_000;

/**
 * Whether a Change's `owner/name` is the repo the key names, on whatever host it is: the key's path after its host
 * (`github.com`, a GitHub Enterprise or GitLab host, `host:port` of an ssh remote).
 */
export function onRepo(key: string, repo: string): boolean {
  const slash = key.indexOf("/");
  return slash > 0 && key.slice(slash + 1) === repo.toLowerCase();
}

/** The claim as it ends: its state, when and why (one line of at most 200 characters), and its landing. */
export function ended(claim: Claim, state: ClaimState, now: number, reason: string, landing?: string): Claim {
  const cut = [...reason].slice(0, 200).join("");
  return {
    ...claim,
    state,
    end: { at: isoMs(now), reason: view.isLine(cut, 200) ? cut : "ended", ...(landing !== undefined ? { landing } : {}) },
  };
}
