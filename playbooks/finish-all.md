---
name: finish-all
version: 3
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
  Finish-all. Call `inventory`: open work ranked (failing checks, open issues, TODO markers). For each item with a value source, highest first, call `workstream_spawn` with the intent as text and its source as serves (issue:, defect: or done:); never invent work. The policy caps open children: keep it full. Children follow their own playbooks: review by tier, PRs carry Source, never merge, claim done, no polish loops. Never estimate time. Call inventory again as each child finishes. When it reports nothing left with a value source, stop: idle is success.
---

# Finish-all

Clear the project's backlog of work that already has a reason to exist, and nothing else.
