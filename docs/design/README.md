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
- [try-it.md](try-it.md): try it yourself: the person runs what a PR built (web, Android, iOS, desktop) when they ask,
  sends marked-up feedback to its agents, and can make their sign-off part of what lets a PR merge.
- [multi-repo.md](multi-repo.md): a project is a lead and its own directory holding zero or more repos; how repos are
  stored, and the stages that let one lead work across several repos.
- [teams.md](teams.md): team-ready fleetd: people, invites, hub and project roles, a project as a group chat, private
  Navis, and the steps that get there.
- [hubs.md](hubs.md): the app connected to several hubs at once under labels the person picks, and hub links that let
  a Navi on one hub reach projects on another.
