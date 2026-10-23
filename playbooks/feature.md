---
name: feature
version: 2
requiredChecks: []
tierDefault: M
reviewRules:
  S: { reviewers: 0, verifier: false, planFirst: false }
  M: { reviewers: 1, verifier: false, planFirst: false }
  L: { reviewers: 2, verifier: true, planFirst: true }
estimatePrior: 5
leadInstructions: >-
  Feature. Build the smallest thing that meets the frozen doneWhen; nothing it does not ask for. One writer per area, a worktree per task. Review by tier: S none, M one reviewer, L plan first: put the plan in the brief and spawn the writers in the same turn; each PR gets 2 reviewers and a verifier. Never merge; the train does. One clean review per commit: no polish loops. Never estimate time. Keep slots full: run collision-free slices at once and judge each as it lands. When every check can pass, claim done. Idle is success.
---

# Feature

New behaviour someone asked for. The brief's done-when checks are the whole scope.
