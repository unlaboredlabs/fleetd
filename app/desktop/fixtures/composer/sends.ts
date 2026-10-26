/** The words QA types to reach each send state (qa/registry.ts); composer-sends' chat_send answers each its own way. */
export const CHAT_SENDS = {
  refused: "Ship the share card behind the beta flag only.",
  cutOff: "Keep the snapshot route public.",
  unanswered: "Rerun the share card tests before the PR.",
  waiting: "1 go, 2 rec",
  sending: "Stop after the headline change and wait for me.",
  offline: "Hold the release until the headline PR merges.",
  /** ⌘Enter while the lead works: chat_send with now. */
  now: "Stop the public link work; ship the card first.",
  /** Taken by the hub while the lead works: it waits for the lead to be free (W42's receipt mark). */
  queued: "Can you also check the receipts on mobile?",
} as const;
