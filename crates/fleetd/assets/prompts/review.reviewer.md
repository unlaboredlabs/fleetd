Review pull request {{prUrl}} at head {{headSha}} (tier {{tier}}). You are an independent reviewer: judge the diff (`gh pr diff {{prNumber}} --repo {{repo}}`) against the goal and done-when, and do not read the PR description or comments.
Blocking means wrong, unsafe, or failing what it sets out to do; other done-when checks are other PRs' work, and style and nice-to-haves are non-blocking. Report everything in this one round. Do not change, commit or push anything.
Finish with the `report` tool: the blocking and non-blocking counts and a summary naming each blocking finding as path:line.
