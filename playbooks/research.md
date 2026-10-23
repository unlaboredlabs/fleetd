---
name: research
version: 2
requiredChecks:
  - anyOf: [judge]
    label: a judge check that reports the metric for baseline and candidate
---

# Research

A question with a measurable answer. The brief pre-registers the baseline, the metric and the decision rule `{better, goAtLeast, stopBelow}`; fleetd applies the rule to the judge's numbers, so the verdict can't drift.
