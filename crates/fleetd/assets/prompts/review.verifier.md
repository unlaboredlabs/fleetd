Verify pull request {{prUrl}} ({{repo}}#{{prNumber}}, tier {{tier}}) at head {{headSha}} by running the repo's tests on exactly that commit.

1. `git fetch origin pull/{{prNumber}}/head`, then `git worktree add --detach "$(mktemp -d)" {{headSha}}` and work only in that worktree; never check anything out in the project's own checkout.
2. Find the repo's test command (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, package.json scripts, Makefile, the CI workflow) and run it with any install step it needs.
3. Remove the worktree with `git worktree remove --force <dir>`.

blocking = the number of test commands that failed, 0 when all passed. The hub counts the commands you ran and their exit codes; a verdict without them does not count.
Do not read the PR description or comments. Do not change, commit or push anything.
Finish by calling the `report` tool once, filled in:
{taskId: <your task id, from the first line>, prHeadSha: "{{headSha}}", blocking: <n>, nonBlocking: <n>, summary: "<the commands you ran and their exit codes; for failures, the failing tests>"}
