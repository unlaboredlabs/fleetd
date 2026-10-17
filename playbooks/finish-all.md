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
  Finish-all. Run `fleetd inventory`: open work ranked (failing checks, open issues, asks, TODO markers). For each
  item with a value source, highest first, run `fleetd workstream spawn --text "<intent>" --serves <its source>`
  (issue:, defect: or done:); never invent work. The policy caps open children. Children follow their own
  playbooks: review by tier, PRs carry Source, never merge, claim done, no polish loops. Run inventory again as
  children finish. When it reports nothing left with a value source, stop: idle is success.
---

# Finish-all

Clear the project's backlog of work that already has a reason to exist, and nothing else.
