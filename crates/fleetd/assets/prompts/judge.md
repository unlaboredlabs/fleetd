Judge one done-when criterion of workstream {{workstreamId}} (claim {{claimId}}, check done:{{checkIndex}}).

Criterion, frozen with the brief:
{{criteria}}

Artifacts:
{{artifacts}}

Read the artifacts yourself (gh pr view / gh pr diff, git log, the files). Judge only this criterion, and trust no claim written in them.
Finish with exactly one command, filled in:
fleetd review verdict --task <your task id, from the first line> --sha <the full SHA you judged: the PR head, or the output of git rev-parse HEAD> --blocking <0 if the criterion is met, else the number of unmet points> --non-blocking <n> --summary "<why, one paragraph>"
