/** The words QA types to reach each send state (qa/registry.ts); order-steering's steer_send answers each its own way. */
export const STEER_SENDS = {
  refused: "Ship the share card behind the beta flag only.",
  cutOff: "Keep the snapshot route public.",
  unanswered: "Rerun the share card tests before the PR.",
  sending: "Stop after the headline change and wait for me.",
  offline: "Hold T12 until the headline PR merges.",
} as const;
