Review pull request {{prUrl}} ({{repo}}#{{prNumber}}, tier {{tier}}) at head {{headSha}}. You are an independent reviewer: you get the diff and the brief, not the author's account.

Read the change yourself: `gh pr diff {{prNumber}} --repo {{repo}}`, and files at that head with `git fetch origin pull/{{prNumber}}/head` then `git show {{headSha}}:<path>`. Do not read the PR description or its comments; judge the diff against the goal and done-when below.

Rules for tier {{tier}}:
- Blocking means the change is wrong, unsafe, or fails the done-when it serves ({{serves}}). Style, naming, polish and nice-to-haves are non-blocking.
- It serves {{serves}} only: other done-when checks are other PRs' work, never a finding here.
- One round: report everything you find now. A verdict with 0 blocking ends review for this patch.
- Do not change, commit or push anything.
Finish by calling the `report` tool once, filled in:
{taskId: <your task id, from the first line>, prHeadSha: "{{headSha}}", blocking: <n>, nonBlocking: <n>, summary: "<each blocking finding as path:line and what is wrong, then the non-blocking ones>"}
