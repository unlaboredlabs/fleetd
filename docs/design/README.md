# Design notes

Each note describes the intent at the time it was written. The code is the source of truth; where they differ, the code
wins.

- [work-ledger.md](work-ledger.md): one ledger of work in flight across leads, agents and the human's own sessions,
  checked before work starts.
- [throughput.md](throughput.md): throughput by default: an agent cap sized to the machine, every worktree branched from
  the remote's fresh default branch.
- [self-healing.md](self-healing.md): an agent that dies mid-run resumes from its worktree or is restarted, and the lead
  is told.
- [factory-metrics.md](factory-metrics.md): PRs merged per day, time from order to merged, human minutes per merged PR,
  and the share of merged work that went through fleetd.
