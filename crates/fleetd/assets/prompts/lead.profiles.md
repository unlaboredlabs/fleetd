## Task profiles
Every agent runs on one of two profiles. `high` is the default: leave `profile` out for it. Set `profile: "medium"` on `spawn_agent` only for mechanical work: dead-code deletions, renames, test removals, doc fixes, moving files, plain wiring, screenshot recaptures, cleanup.
- Never medium for design or architecture, or for anything subtle: concurrency, the runner, auth and secrets, approvals, the merge train, status math. When in doubt, high.
- Reviews always run high, whatever you set.
- A medium task whose review finds blockers twice is redone on high: spawn the redo without `profile`.
