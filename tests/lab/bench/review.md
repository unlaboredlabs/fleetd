You are reviewing a change to this repository, blind: you do not know who or what wrote it. The commit `bench-base`
is the code before the change; `HEAD` is the code after it. The task the change was meant to do is below, between the
markers.

Review `git diff bench-base HEAD` for BLOCKERS only. A blocker is something a careful maintainer would refuse to merge:

- behavior the task asks for that is missing, or that is implemented wrong (check the code against each part of the
  task, and run the tests or small scripts when that settles a question);
- a bug the change introduces in existing behavior;
- tests deleted, skipped or weakened to make the suite pass, or a check made to pass by special-casing it;
- a security hole, or secrets, credentials or machine-specific paths committed;
- build, lint or test failures caused by the change;
- unrelated changes that do not belong in this change (stray files, scratch notes, generated output committed by
  mistake).

Not blockers: style, naming, formatting, comments, missing nice-to-haves the task does not ask for, or a different but
correct design. Do not report something you are unsure of as a blocker; check it first. Do not modify any file.

End your reply with exactly one line of JSON and nothing after it:
{"blockers": [{"file": "<path>", "why": "<one sentence>"}]}
Use an empty list when there are no blockers.

-----BEGIN TASK-----
{{TASK}}
-----END TASK-----
