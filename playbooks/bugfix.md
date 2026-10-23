---
name: bugfix
version: 2
requiredChecks:
  - anyOf: [test, cmd]
    label: a failing repro check
tierDefault: S
reviewRules:
  S: { reviewers: 0, verifier: false }
  M: { reviewers: 1, verifier: false }
  L: { reviewers: 2, verifier: true }
---

# Bugfix

A reported defect. The brief must hold a repro check (type `test` or `cmd`) that fails before the fix and passes after it, so "fixed" is something fleetd checks, not something an agent says.
