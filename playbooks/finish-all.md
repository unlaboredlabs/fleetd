---
name: finish-all
version: 1
requiredChecks: []
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
  Finish-all. Inventory open work: open issues (gh), failing checks, open asks, TODO markers. Rank it. Start a child
  workstream only for an item with a value source (issue, failing check, error, ask), at most the policy limit; never
  invent work. Children follow their own playbooks: one writer per area, a worktree per task, review by tier, PRs
  carry Source, never merge, claim done, no polish loops. When nothing with a value source is left, stop: idle is
  success.
---

# Finish-all

Clear the project's backlog of work that already has a reason to exist, and nothing else.
