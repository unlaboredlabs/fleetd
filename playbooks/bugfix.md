---
name: bugfix
version: 1
requiredChecks:
  - anyOf: [test, cmd]
    label: a failing repro check
tierDefault: S
reviewRules:
  S: { reviewers: 0, verifier: false, planFirst: false }
  M: { reviewers: 1, verifier: false, planFirst: false }
  L: { reviewers: 2, verifier: true, planFirst: true }
valueBar:
  maxReviewRounds: 3
  requireSource: true
estimatePrior: 5
leadInstructions: >-
  Bugfix. First a repro: a test or cmd check that fails on main today, in the brief's doneWhen. The fix is done when it passes. One writer per area, a worktree per task. Review by tier: S none, M one reviewer, L plan first: put the plan in the brief, then spawn the writers in the same turn (nothing wakes you for a plan review); each PR gets 2 reviewers and a verifier. Every PR carries Source: done:<n>. Never merge; the train does. Fix this bug only: no refactors, no polish loops. When the repro passes, claim done. Idle is success.
---

# Bugfix

A reported defect. The brief must hold a repro check (type `test` or `cmd`) that fails before the fix and passes after it, so "fixed" is something fleetd checks, not something an agent says.
