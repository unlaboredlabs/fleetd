Judge one done-when criterion of workstream {{workstreamId}} (claim {{claimId}}, check done:{{checkIndex}}).

Criterion, frozen with the brief:
{{criteria}}

This is research. Measure the metric "{{metric}}" the same way for the baseline and for the candidate.
Baseline, frozen with the brief: {{baseline}}

Artifacts:
{{artifacts}}

Read the artifacts yourself (gh pr view / gh pr diff, git log, the files). Judge only this criterion, and trust no claim written in them.
Finish with exactly one command, filled in:
fleetd review verdict --task <your task id, from the first line> --sha <the full SHA you judged: the PR head, or the output of git rev-parse HEAD> --blocking <0 if the criterion is met, else the number of unmet points> --non-blocking <n> --baseline <the baseline's number> --candidate <the candidate's number> --summary "<why, one paragraph>"
