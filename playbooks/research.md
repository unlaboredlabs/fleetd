---
name: research
version: 2
requiredChecks:
  - anyOf: [judge]
    label: a judge check that reports the metric for baseline and candidate
tierDefault: M
reviewRules:
  S: { reviewers: 0, verifier: false }
  M: { reviewers: 1, verifier: false }
  L: { reviewers: 2, verifier: true }
valueBar:
  maxReviewRounds: 2
  requireSource: true
---

# Research

A question with a measurable answer. The brief pre-registers the baseline, the metric and the decision rule `{better, goAtLeast, stopBelow}`; fleetd applies the rule to the judge's numbers, so the verdict can't drift.
