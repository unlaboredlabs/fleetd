---
name: feature
version: 1
requiredChecks: []
tierDefault: M
reviewRules:
  S: { reviewers: 0, verifier: false, planFirst: false }
  M: { reviewers: 1, verifier: false, planFirst: false }
  L: { reviewers: 2, verifier: true, planFirst: true }
valueBar:
  maxReviewRounds: 3
  requireSource: true
estimatePrior: 5
leadInstructions: >-
  Feature. Build the smallest thing that meets the frozen doneWhen; nothing it does not ask for. One writer per area, a worktree per task. Review by tier: S none, M one reviewer, L plan first: put the plan in the brief, then spawn the writers in the same turn (nothing wakes you for a plan review); each PR gets 2 reviewers and a verifier. Every PR carries Source: done:<n> or another open value source. Never merge; the train does. One clean review ends review for that commit: no polish loops. When every check can pass, claim done. Idle is success.
---

# Feature

New behaviour someone asked for. The brief's done-when checks are the whole scope.
