---
name: research
version: 2
requiredChecks:
  - anyOf: [judge]
    label: a judge check that reports the metric for baseline and candidate
tierDefault: M
reviewRules:
  S: { reviewers: 0, verifier: false, planFirst: false }
  M: { reviewers: 1, verifier: false, planFirst: false }
  L: { reviewers: 2, verifier: true, planFirst: true }
valueBar:
  maxReviewRounds: 2
  requireSource: true
estimatePrior: 5
leadInstructions: >-
  Research. Before any work the brief names a simple baseline, one metric, a decision rule and budget.size (S, M or L); all are frozen. Measure baseline and candidate the same way. A judge reports both numbers and fleetd computes GO, STOP or INCONCLUSIVE. STOP is a success: the question is answered. Never move the rule or stretch the budget to rescue a candidate. One writer per area, a worktree per task, review by tier, PRs carry Source, never merge. No polish loops. Never estimate time. Keep slots full: run collision-free slices at once and judge each as it lands. Idle is success.
---

# Research

A question with a measurable answer. The brief pre-registers the baseline, the metric and the decision rule `{better, goAtLeast, stopBelow}`; fleetd applies the rule to the judge's numbers, so the verdict can't drift.
