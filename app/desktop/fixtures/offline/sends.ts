/** What the offline fixture's cache holds queued, and what QA types offline (qa/registry.ts). */
export const OFFLINE_SENDS = {
  queued: "Hold the release until the headline PR merges.",
  typed: "And keep the share card behind the beta flag.",
} as const;
