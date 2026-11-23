---
title: Merge train
description: How fleetd reviews and merges pull requests, who merges, and how to hold a PR.
---

The merge train reviews each agent's PR, runs CI, and merges it, or leaves the merge to you.

Each repo has its own train. Every PR an agent opens goes on it by itself. PRs from forks or from people's own
branches never do.

## Who merges {#who-merges}

Each bot picks who merges its PRs, in its settings under **Safety › Who merges**:

- **You** (the default for new bots): fleetd reviews each PR and keeps it up to date. You merge it on GitHub. Only PRs
  your [risk rules](#risk-rules) allow merge by themselves.
- **fleetd**: the train merges each PR once it's reviewed and CI is green.

You can also set it from a terminal on the hub: `fleetd project set <machine>/<bot> --merges you|fleetd --key-file
<your key>`. Only a person can change it, never an agent.

### When you merge {#people-merge}

- fleetd's reviewer still reviews each PR, and problems go back to the agent that wrote it.
- The lead tells you once when a PR is reviewed and green, with its link.
- The PR shows **Waiting for you to merge on GitHub**, and appears under **Needs a look**.
- While it waits, the train updates it with the base branch at most once an hour.

When you merge it on GitHub, fleetd records the merge, and the PRs behind it carry on.

### Risk rules {#risk-rules}

On a bot you merge, press **Rules** next to **Who merges**. There are two lists, one rule per line:

- **Merges itself when every file matches**: the PR merges by itself if every file matches a rule here. Default:
  `docs`, `tests`, `lockfile-bumps`, `formatting`.
- **Always waits for a person when any file matches**: the PR waits for you if any file matches, whatever the first
  list says. Default: `auth`, `billing`, `migrations`, `infra`, `ci`, `secrets`.

A rule is a path pattern or a named kind:

- A pattern such as `docs/**` or `*.sql`. `**` spans folders. A pattern with no `/` matches a file name in any folder.
- `docs`: Markdown and similar files in `docs/`, and READMEs. Never files that instruct agents, such as `CLAUDE.md` or
  `AGENTS.md`.
- `tests`: test folders and test files.
- `lockfile-bumps`: lockfiles whose only change is patch or minor version bumps.
- `formatting`: changes that only add or remove blank lines or trailing spaces.
- `auth`, `billing`, `migrations`, `infra`, `ci`, `secrets`: the folders and files those words usually name, such as
  `auth/`, `*.sql`, `Dockerfile`, `.github/` or `.env`.

Empty both lists and every PR waits for you. A PR whose files GitHub can't list waits for you too.

## Hold a PR {#hold}

Add the `hold` label to a PR to keep the train off it. Remove the label and it goes in its turn.

Use it for a one-off. To hold every PR of a bot, set **Who merges** to **You**.

## How it merges {#modes}

Each bot also picks how the train merges, under **Safety › How it merges**:

- **Test, then merge** (the default): ready PRs merge in batches, up to 8 at a time. CI runs on the combined code
  first, so main stays green. If a batch fails, its PRs go one at a time.
- **Merge, then verify**: each PR merges as soon as its own CI passes on the latest main, up to 4 at a time. If main
  then goes red, fleetd finds the PR that broke it and reverts it.

Pick **Merge, then verify** when CI is slow and many PRs land each day. Pick **Test, then merge** when main must never
be red, even briefly.

### Merge, then verify {#verify}

1. The train rebases the PR on main and waits for its CI.
2. It merges the moment CI passes.
3. It then watches main's own CI.

When a check fails on main, the train re-runs it once. If it passes, it was flaky and nothing happens. If it fails
again:

1. The train finds the first merge where it went red, looking up to 30 merges back.
2. It opens a revert PR and puts it first in line.
3. The agent that wrote the change hears it was reverted, and brings it back with a fix.

If it can't pin the failure on one merge, it opens a fix request for the bot's lead instead.

A repo can change how many PRs run CI at once (1 to 16) in `.fleetd/train.json`:

```json
{ "ciAtOnce": 2 }
```

If main requires branches to be up to date before merging, PRs still land one at a time. The setting says so, and
offers repo admins a button to turn just that rule off.

## What happens to each PR {#steps}

1. **Review.** A fresh reviewer agent reads the PR. Blocking problems go back to the agent that wrote it.
2. **Rebase.** The train updates the PR with its base branch.
3. **CI.** It waits for the repo's checks. A failed check is re-run once, to rule out a flaky test.
4. **Merge.** It posts the `fleetd/train` status and squash-merges.

Conflicts and red CI go back to the agent that wrote the PR. A pushed fix goes back in line by itself.

A repo with no CI at all merges on review alone.

## Review {#review}

Every PR gets a fresh reviewer. It blocks only on a real problem: a bug someone can hit today, a security hole, or a
miss against what was asked. Smaller notes don't block.

The verdict is posted on the PR as one comment, updated on each new review. It never counts as a GitHub approval.

A new push gets a new review. If only a rebase changed it, the approval carries over.

### People's reviews on GitHub {#people}

Review a fleetd PR on GitHub as you would any PR. Within about a minute:

- **Request changes**: the PR waits, and your review goes to the agent that wrote it. It waits until you approve or
  dismiss the review.
- **A comment on a line**: goes to the agent too. The PR waits until you resolve the thread.
- **A plain comment**: nothing happens.

The agent fixes it, pushes and replies. It never resolves your threads or dismisses your review: you do that.

Only reviews from the repo's owner, organization members or collaborators count.

## The repo's GitHub rules {#rules}

The train follows the base branch's rules on GitHub. There's nothing to set in fleetd, and fleetd never gets around a
rule.

- **Required approval**: the PR waits for a person to approve it on GitHub, then merges in its turn. PRs go one at a
  time, never in batches.
- **Merge method**: squash if the repo allows it, then rebase, then a merge commit.
- **A rule fleetd can't meet** (signed commits, push restrictions): the lead is told once, with GitHub's words.

A base that requires GitHub's own merge queue isn't supported.

## After the merge {#after-merge}

The train watches main's checks after each merge, including nightly scheduled runs. When one fails, fleetd opens a fix
request for the bot's lead. One failure opens one request.

PRs merged outside the train, by hand on GitHub, are noticed within a minute. The train carries on from the new base.

## One PR after another {#order}

When one PR needs another merged first, the lead tells the train the order, across repos too. The later PR waits,
showing "waiting on" the earlier one.

A PR built on another agent's open PR waits for it without being told.

## Several repos {#repos}

A bot with several repos has one train per repo. Each repo's PRs line up and merge on their own.

## Set up your repo's CI {#ci}

The train works with any CI. To pick which checks it waits for, skip slow jobs on batches, or have it regenerate
built files, see [CI for the merge train](/docs/merge-train-ci).

## What never changes {#guarantees}

- Every PR is reviewed before it merges.
- A person's change request or open thread holds the PR.
- The checks the base branch requires always pass first.
- GitHub's rules decide every merge. fleetd never approves its own PRs.
- With **Merge, then verify**, each PR merges only on its own green CI, and a red main is reverted.
