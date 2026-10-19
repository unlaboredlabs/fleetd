//! Every prompt and message fleetd sends a model, with its shipped text, the placeholders the code fills in and the
//! safety rules the text carries. The shipped texts are `assets/prompts/<id>.md`; playbooks stay in `playbooks/`.
use fleetd_contracts::ledger::PlaybookName;
use fleetd_contracts::prompts::{Enforcement, Placeholder, PromptGroup, PromptKind, SafetyRule};

use crate::hub::playbooks::load::BUNDLED;

/// Which sessions pin an entry at their start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Audience {
    Lead,
    Task,
    /// Any thread: leads, tasks, and threads an outside agent launched.
    Any,
    /// Resolved at each call (router, retro) or pinned by its own loader (playbooks).
    None,
}

pub struct Entry {
    pub id: &'static str,
    pub title: &'static str,
    pub kind: PromptKind,
    pub group: PromptGroup,
    pub audience: Audience,
    pub sent_when: &'static str,
    pub default: &'static str,
    /// `name=description; …`, a `!` after the name marks it required.
    placeholders: &'static str,
    rules: &'static [(&'static str, &'static str, &'static str, Enforcement)],
}

impl Entry {
    pub fn per_project(&self) -> bool {
        !matches!(self.kind, PromptKind::Oneshot | PromptKind::Playbook)
    }

    pub fn playbook(&self) -> Option<PlaybookName> {
        let name = self.id.strip_prefix("playbook.")?;
        PlaybookName::ALL.into_iter().find(|n| n.as_str() == name)
    }

    pub fn placeholders(&self) -> Vec<Placeholder> {
        self.placeholders
            .split(';')
            .filter_map(|p| {
                let (name, description) = p.trim().split_once('=')?;
                let required = name.ends_with('!');
                Some(Placeholder {
                    name: name.trim_end_matches('!').to_owned(),
                    required,
                    description: description.trim().to_owned(),
                })
            })
            .collect()
    }

    pub fn safety_rules(&self) -> Vec<SafetyRule> {
        self.rules
            .iter()
            .map(|(id, label, needle, enforced)| SafetyRule {
                id: (*id).to_owned(),
                label: (*label).to_owned(),
                needle: (*needle).to_owned(),
                enforced: *enforced,
                present: None,
            })
            .collect()
    }

    /// Past this many characters an edit gets a `too_long` warning.
    pub fn budget(&self) -> usize {
        self.default.chars().count() * 3 + 500
    }
}

macro_rules! asset {
    ($id:literal) => {
        include_str!(concat!("../../../assets/prompts/", $id, ".md"))
    };
}

use Audience::{Any, Lead, Task};
use Enforcement::{Code, Prompt};
use PromptGroup as G;
use PromptKind as K;

const WS: &str = "workstreamId!=the order's workstream, W<n>";

macro_rules! entry {
    ($id:literal, $kind:ident, $group:ident, $aud:expr, $title:literal, $when:literal, $ph:expr, $rules:expr) => {
        Entry {
            id: $id,
            title: $title,
            kind: K::$kind,
            group: G::$group,
            audience: $aud,
            sent_when: $when,
            default: asset!($id),
            placeholders: $ph,
            rules: $rules,
        }
    };
}

const VERDICT: (&str, &str, &str, Enforcement) = (
    "one-verdict",
    "ends with one `fleetd review verdict`",
    r"review verdict",
    Code,
);
const NO_SUBAGENTS: (&str, &str, &str, Enforcement) = (
    "no-subagents",
    "does the task itself, no subagents",
    r"subagents",
    // Every session's claude runs with the subagent tools (Task, Workflow) disallowed: see ALWAYS_DISALLOWED.
    Code,
);
const READ_ONLY: (&str, &str, &str, Enforcement) = (
    "read-only",
    "changes no files",
    r"do not change, commit or push",
    Prompt,
);

pub const ENTRIES: &[Entry] = &[
    entry!(
        "lead.start",
        Start,
        Lead,
        Lead,
        "Lead: first message",
        "lead start and every lead_restart, followed by the digest",
        "project!=the project's title; projectRef!=<machineId>/<projectId>",
        &[
            (
                "never-write-code",
                "the lead never writes code",
                r"never write code",
                Prompt
            ),
            (
                "tasks-only",
                "delegates only with `fleetd task spawn`, no other agents",
                r"fleetd task spawn",
                Prompt
            ),
            (
                "ask-four-classes",
                "asks the human only about product, money, credentials, irreversible",
                r"product, money, credential",
                Prompt
            ),
            (
                "secrets-via-ask",
                "secrets only through `fleetd ask --kind secret`",
                r"ask --kind secret",
                Code
            ),
            (
                "gated-run",
                "prod writes, spends and deletes only through `fleetd gated run`",
                r"gated run",
                Code
            ),
            (
                "never-block",
                "never blocks on a question (`--proceeded`)",
                r"--proceeded",
                Prompt
            ),
            (
                "claim-done",
                "done only through `fleetd claim done`",
                r"claim done",
                Code
            ),
            (
                "serves",
                "every write says what it serves",
                r"--serves",
                Code
            ),
            (
                "train-only-merges",
                "only the merge train merges",
                r"never merge",
                Code
            ),
            (
                "no-re-ask",
                "never re-asks a key the digest lists",
                r"never re-ask",
                Prompt
            ),
            (
                "amend",
                "a frozen brief changes only with `--amend`",
                r"--amend",
                Code
            ),
        ]
    ),
    entry!(
        "lead.digest",
        Wake,
        Lead,
        Lead,
        "Lead: project digest",
        "the top of the lead's first message and of every wake",
        "project!=the project's title; projectRef!=<machineId>/<projectId>; at!=now; sections!=the digest's sections, rendered by fleetd",
        &[(
            "digest-is-truth",
            "the digest is the truth, over the lead's memory",
            r"current truth",
            Prompt
        )]
    ),
    entry!(
        "digest.workstream.no_brief",
        Wake,
        WakesAndMessages,
        Lead,
        "Digest: order without a brief",
        "each digest, per draft order",
        WS,
        &[]
    ),
    entry!(
        "digest.finish_all_idle",
        Wake,
        WakesAndMessages,
        Lead,
        "Digest: finish-all is idle",
        "each digest, per idle finish-all order",
        "",
        &[]
    ),
    entry!(
        "digest.answer.withdrawn",
        Wake,
        WakesAndMessages,
        Lead,
        "Digest: an ask the human dropped",
        "each digest, per dropped ask",
        "askId!=the ask, A<n>; key!=its decision key",
        &[]
    ),
    entry!(
        "digest.answer.skipped",
        Wake,
        WakesAndMessages,
        Lead,
        "Digest: an ask the human skipped for now",
        "each digest, per skipped ask",
        "askId!=the ask, A<n>; key!=its decision key; value!=your recommendation, with its label",
        &[]
    ),
    entry!(
        "digest.tasks.running",
        Wake,
        WakesAndMessages,
        Lead,
        "Digest: running task",
        "each digest, per running task",
        "taskId!=the task, T<n>; kind!=write, read or review; model!=model/effort; title!=its title; branch!=its branch in brackets, or nothing",
        &[]
    ),
    entry!(
        "digest.tasks.idle",
        Wake,
        WakesAndMessages,
        Lead,
        "Digest: task waiting for input",
        "each digest, per idle task",
        "taskId!=the task, T<n>; kind!=write, read or review; model!=model/effort; title!=its title; branch!=its branch in brackets, or nothing",
        &[]
    ),
    entry!(
        "digest.tasks.queued",
        Wake,
        WakesAndMessages,
        Lead,
        "Digest: queued task",
        "each digest, per queued task",
        "taskId!=the task, T<n>; kind!=write, read or review; title!=its title; reason!=why it waits",
        &[]
    ),
    entry!(
        "digest.tasks.ended",
        Wake,
        WakesAndMessages,
        Lead,
        "Digest: task ended",
        "each digest, per task ended since the last wake",
        "taskId!=the task, T<n>; state!=done, failed or cancelled; title!=its title; result!=` → ` and its result's first line, or nothing",
        &[]
    ),
    entry!(
        "digest.train.repo",
        Wake,
        WakesAndMessages,
        Lead,
        "Digest: a repo's merge train",
        "each digest, per train",
        "repo!=owner/name; state!=running or frozen, its head and queue",
        &[]
    ),
    entry!(
        "digest.train.merged",
        Wake,
        WakesAndMessages,
        Lead,
        "Digest: merged PR",
        "each digest, per merge since the last wake",
        "changeId!=the change, X<n>; since!=` since your last wake`, or nothing; pr!=the PR; sha!=the merge commit, or nothing; serves!=what it serves; by!=`, by T<n>`, or nothing",
        &[]
    ),
    entry!(
        "digest.train.parked",
        Wake,
        WakesAndMessages,
        Lead,
        "Digest: PR back with its author",
        "each digest, per PR needing a rebase or red CI",
        "changeId!=the change, X<n>; state!=its state; pr!=the PR; by!=`, by T<n>`, or nothing; error!=what went wrong",
        &[]
    ),
    entry!(
        "digest.train.waived",
        Wake,
        WakesAndMessages,
        Lead,
        "Digest: waived PR",
        "each digest, per waived PR",
        "changeId!=the change, X<n>; pr!=the PR; state!=its state; reason!=the waiver",
        &[]
    ),
    entry!(
        "wake.frame",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: frame",
        "every wake",
        "digest!=the digest; lines!=why the lead is woken, one entry per trigger",
        &[]
    ),
    entry!(
        "wake.intent",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: new order",
        "per new order",
        "workstreamId!=the order's workstream, W<n>; text!=the order's words",
        &[]
    ),
    entry!(
        "wake.intent.playbook",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: the order's playbook",
        "per new order with a playbook the digest does not show",
        "playbook!=its name; instructions!=its leadInstructions",
        &[]
    ),
    entry!(
        "wake.intent.playbook_listed",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: the order's playbook, listed above",
        "per new order with a playbook the digest shows",
        "playbook!=its name",
        &[]
    ),
    entry!(
        "wake.decision",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: a human decision",
        "per decision the human recorded in the project",
        "who!=who recorded it; decisionId!=D<n>; key!=its key; value!=its value; scope!=its scope",
        &[]
    ),
    entry!(
        "wake.answers",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: answers",
        "per batch of answers",
        "count!=how many asks were settled",
        &[]
    ),
    entry!(
        "wake.task_result",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: task finished",
        "per task that completed or failed",
        "taskId!=the task, T<n>; verb!=completed or failed; title!=its title; where!=its branch and PR, or nothing; receipts!=its receipts line, or nothing; result!=its final message, quoted",
        &[]
    ),
    entry!(
        "wake.task_cancelled",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: task cancelled",
        "per cancelled task",
        "taskId!=the task, T<n>; title!=its title; where!=its branch and PR, or nothing; receipts!=its receipts line, or nothing; result!=its final message, quoted",
        &[]
    ),
    entry!(
        "wake.task_waiting",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: task asks a question",
        "per task waiting on input",
        "taskId!=the task, T<n>; title!=its title; question!=its question, quoted",
        &[(
            "ask-four-classes",
            "asks the human only about product, money, credentials, irreversible",
            r"product, money, credential",
            Prompt
        )]
    ),
    entry!(
        "wake.task_start_failed",
        Msg,
        WakesAndMessages,
        Lead,
        "Task could not start",
        "per queued task that failed to start (its result)",
        "message!=why",
        &[]
    ),
    entry!(
        "wake.claim_failed",
        Wake,
        ReviewsAndChecks,
        Lead,
        "Wake: claim failed",
        "per failed done claim",
        "claimId!=C<n>; workstreamId!=W<n>; failures!=the failed checks with evidence; firstCheck!=the first failed check's index",
        &[]
    ),
    entry!(
        "wake.claim_passed",
        Wake,
        ReviewsAndChecks,
        Lead,
        "Wake: claim passed",
        "per claim that passed late",
        "claimId!=C<n>; workstreamId!=W<n>",
        &[]
    ),
    entry!(
        "wake.train.line",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: train message for the lead",
        "when the train could not reach a PR's author task",
        "changeId!=X<n>; prUrl!=the PR; text!=the message meant for the author",
        &[]
    ),
    entry!(
        "wake.train.left",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: PR left the train",
        "per PR the train abandoned",
        "changeId!=X<n>; prUrl!=the PR; why!=why",
        &[]
    ),
    entry!(
        "wake.train.merged",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: PR merged",
        "per merge",
        "changeId!=X<n>; prUrl!=the PR; sha!=` as <sha>`, or nothing; tier!=S, M or L; serves!=what it serves; by!=`, by T<n>`, or nothing",
        &[]
    ),
    entry!(
        "wake.train.gave_up",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: train gave up",
        "per PR GitHub refused to merge too often",
        "changeId!=X<n>; prUrl!=the PR; why!=GitHub's reason; tries!=how many tries",
        &[]
    ),
    entry!(
        "wake.train.refused",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: train refused a PR",
        "per task PR the train would not take",
        "prUrl!=the PR; taskId!=the task, T<n>; message!=why; fix!=` Fix: …`, or nothing",
        &[]
    ),
    entry!(
        "wake.research_verdict.go",
        Wake,
        ReviewsAndChecks,
        Lead,
        "Wake: research verdict GO",
        "per research claim that went GO",
        "measured!=the two numbers and the improvement; go!=the go line",
        &[]
    ),
    entry!(
        "wake.research_verdict.stop",
        Wake,
        ReviewsAndChecks,
        Lead,
        "Wake: research verdict STOP",
        "per research claim that went STOP",
        "measured!=the two numbers and the improvement; stop!=the stop line",
        &[(
            "stop-is-success",
            "STOP is a success",
            r"STOP is a success",
            Prompt
        )]
    ),
    entry!(
        "wake.research_verdict.inconclusive",
        Wake,
        ReviewsAndChecks,
        Lead,
        "Wake: research verdict INCONCLUSIVE",
        "per research claim that was inconclusive",
        "measured!=the two numbers and the improvement; stop!=the stop line; go!=the go line",
        &[]
    ),
    entry!(
        "steer.message",
        Msg,
        WakesAndMessages,
        Any,
        "A steer: the human's (or the lead's) words mid-run",
        "per steer (steer_send, order_note, task message), straight to the agent, at its next tool boundary or now",
        "id!=the steer, S<n>; who!=the human or your lead; scope!=the order (W<n> 'title') or the task (T<n> (kind) for W<n>); text!=the words; references=references and attachments, or nothing",
        &[(
            "names-steer",
            "asks the agent to name the steer first, so its receipt can say it was acknowledged",
            r"\{\{id\}\}:",
            Prompt
        )]
    ),
    entry!(
        "wake.agent_steer",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: the human steered one of your tasks directly",
        "per steer_send to a task, at the lead's next wake (debounced, never an interrupt)",
        "id!=the steer, S<n>; taskId!=T<n>; kind!=write, read or review; text!=the human's words",
        &[]
    ),
    entry!(
        "wake.order_refs",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: what came with a new order",
        "per new order with references or attachments",
        "workstreamId!=W<n>; references!=references and attachments",
        &[]
    ),
    entry!(
        "wake.order_stopped",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: the human stopped an order",
        "per order_stop",
        "workstreamId!=W<n>; title!=the order's title; why!=why; cancelled!=how many tasks were cancelled",
        &[(
            "stop-work",
            "does no more work on a stopped order",
            r"do no more work",
            Prompt
        )]
    ),
    entry!(
        "wake.order_idle",
        Wake,
        WakesAndMessages,
        Lead,
        "Wake: an order nobody works on",
        "when the lead ends a turn with a frozen order and nothing under way",
        "workstreamId!=W<n>; title!=the order's title",
        &[]
    ),
    entry!(
        "wake.scheduled_late",
        Msg,
        WakesAndMessages,
        Any,
        "Scheduled wake, late",
        "a wake_set message that fired late",
        "minutes!=how late; message!=the scheduled message",
        &[]
    ),
    entry!(
        "wake.scheduled_held",
        Msg,
        WakesAndMessages,
        Any,
        "Scheduled wake, held by a usage pause",
        "a wake_set message held by a usage pause",
        "minutes!=how long it was held; message!=the scheduled message",
        &[]
    ),
    entry!(
        "task.brief.write",
        Start,
        Tasks,
        Task,
        "Write task: first message",
        "every write task attempt",
        "taskId!=T<n>; kind=write; workstreamId=W<n>; project=the project's title; title=the task's title; task!=the lead's task text; workstream=the order's goal, done-when and what this serves, or nothing; areas!=the leased areas and their globs; branch!=the task's branch; baseBranch=the default branch; serves!=what the task serves",
        &[
            (
                "areas",
                "changes only its areas",
                r"only change files in these areas",
                Code
            ),
            (
                "train-only-merges",
                "never merges; the train does",
                r"never merge",
                Code
            ),
            (
                "source-line",
                "the PR body carries `Source:`",
                r"Source:",
                Code
            ),
            NO_SUBAGENTS,
        ]
    ),
    entry!(
        "task.brief.read",
        Start,
        Tasks,
        Task,
        "Read task: first message",
        "every read task attempt",
        "taskId!=T<n>; kind=read; workstreamId=W<n>; project=the project's title; title=the task's title; task!=the lead's task text; workstream=the order's goal, done-when and what this serves, or nothing",
        &[READ_ONLY, NO_SUBAGENTS]
    ),
    entry!(
        "task.brief.review",
        Start,
        Tasks,
        Task,
        "Review task: first message",
        "every review, verifier and judge task attempt",
        "taskId!=T<n>; kind=review; workstreamId=W<n>; project=the project's title; title=the task's title; task!=the review, verify or judge text; workstream=the order's goal, done-when and what this serves, or nothing",
        &[READ_ONLY, NO_SUBAGENTS, VERDICT]
    ),
    entry!(
        "review.reviewer",
        Start,
        ReviewsAndChecks,
        Task,
        "Reviewer",
        "per PR head per review round, by the tier's rules; Claude or Codex",
        "prUrl!=the PR; repo=owner/name; prNumber!=its number; tier=S, M or L; headSha!=the head reviewed; serves=what the PR serves",
        &[
            (
                "independent-review",
                "does not read the PR description or comments",
                r"do not read the PR description",
                Prompt
            ),
            READ_ONLY,
            VERDICT,
        ]
    ),
    entry!(
        "review.verifier",
        Start,
        ReviewsAndChecks,
        Task,
        "Verifier",
        "tier L, per PR head",
        "prUrl!=the PR; repo=owner/name; prNumber!=its number; tier=S, M or L; headSha!=the head verified",
        &[
            (
                "detached-worktree",
                "works in a detached temporary worktree",
                r"--detach",
                Prompt
            ),
            (
                "independent-review",
                "does not read the PR description or comments",
                r"do not read the PR description",
                Prompt
            ),
            READ_ONLY,
            VERDICT,
        ]
    ),
    entry!(
        "judge",
        Start,
        ReviewsAndChecks,
        Task,
        "Judge",
        "per `judge` done-when check of each claim",
        "workstreamId!=W<n>; claimId=C<n>; checkIndex=the check's index; criteria!=the criterion; artifacts!=PRs and branches to read",
        &[
            (
                "trust-no-claim",
                "trusts no claim in the artifacts",
                r"trust no claim",
                Prompt
            ),
            VERDICT
        ]
    ),
    entry!(
        "judge.research",
        Start,
        ReviewsAndChecks,
        Task,
        "Judge, research",
        "per `judge` check of a research claim",
        "workstreamId!=W<n>; claimId=C<n>; checkIndex=the check's index; criteria!=the criterion; artifacts!=PRs and branches to read; metric!=the metric; baseline!=the baseline",
        &[
            (
                "trust-no-claim",
                "trusts no claim in the artifacts",
                r"trust no claim",
                Prompt
            ),
            VERDICT
        ]
    ),
    entry!(
        "task.review_findings",
        Msg,
        ReviewsAndChecks,
        Task,
        "Blocking findings to the author",
        "per blocking review verdict",
        "reviewTaskId!=the review task; prUrl!=the PR; headSha!=the head reviewed; blocking!=`<n> blocking finding(s)`; nonBlocking!=how many non-blocking; summary!=the findings; branch!=the PR's branch",
        &[(
            "train-only-merges",
            "never merges; the train does",
            r"do not merge it yourself",
            Code
        )]
    ),
    entry!(
        "task.train_rebase",
        Msg,
        Tasks,
        Task,
        "PR needs a rebase",
        "per PR the train could not rebase",
        "prUrl!=the PR; changeId!=X<n>; why!=what failed; branch!=the PR's branch; base!=the base branch",
        &[]
    ),
    entry!(
        "task.train_ci_failed",
        Msg,
        Tasks,
        Task,
        "PR's CI is red",
        "per PR whose CI failed or timed out",
        "prUrl!=the PR; changeId!=X<n>; why!=what failed; branch!=the PR's branch",
        &[]
    ),
    entry!(
        "plan.granularity",
        Msg,
        Lead,
        Lead,
        "Plan item too big or unsized",
        "when `fleetd plan add` (or `plan edit --size`) gets an item with no size or one bigger than m",
        "item!=P<n>; reason!=why, \"has no size (counted as m)\" or \"is size l\"",
        &[]
    ),
    entry!(
        "watchdog.nudge",
        Msg,
        WakesAndMessages,
        Any,
        "Stall nudge",
        "once per stalled run",
        "",
        &[]
    ),
    entry!(
        "usage.continue",
        Msg,
        WakesAndMessages,
        Any,
        "Continue after a usage limit",
        "per parked thread when the usage limit resets",
        "",
        &[]
    ),
    entry!(
        "permission.denied.policy",
        Msg,
        WakesAndMessages,
        Any,
        "Tool denied by policy",
        "per tool call a tools.deny rule refuses (tool result)",
        "rule!=the rule; policyFile!=the policy file",
        &[]
    ),
    entry!(
        "permission.denied.withdrawn",
        Msg,
        WakesAndMessages,
        Any,
        "Tool ask withdrawn",
        "per tool ask withdrawn before an answer (tool result)",
        "askId!=A<n>; by!=who withdrew it",
        &[(
            "no-retry",
            "does not retry the call",
            r"don't retry",
            Prompt
        )]
    ),
    entry!(
        "permission.denied.human",
        Msg,
        WakesAndMessages,
        Any,
        "Tool denied by the human",
        "per tool ask the human denied (tool result)",
        "by!=who; askId!=A<n>; said=`: ` and what they said, or nothing",
        &[]
    ),
    entry!(
        "permission.denied.answer",
        Msg,
        WakesAndMessages,
        Any,
        "Tool denied with thread_answer",
        "per tool call denied with thread_answer and no message (tool result)",
        "by!=who",
        &[]
    ),
    entry!(
        "router",
        Oneshot,
        OneShots,
        Audience::None,
        "Order router",
        "each order without @project or a template prefix",
        "projects!=the projects, one JSON object per line; intent!=the order's words",
        &[
            ("no-tools", "uses no tools", r"do not use tools", Code),
            (
                "json-only",
                "replies with JSON only",
                r"only one JSON object",
                Prompt
            ),
        ]
    ),
    entry!(
        "status.headline",
        Oneshot,
        OneShots,
        Audience::None,
        "Status headline",
        "when a viewed status scope's facts change",
        "facts!=the fact list as JSON; scope!=fleet, a project or an order",
        &[
            ("no-tools", "uses no tools", r"do not use tools", Code),
            (
                "one-line",
                "replies with one line of at most 160 characters",
                r"one line",
                Code
            ),
            (
                "numbers-from-facts",
                "uses only numbers from the facts",
                r"only numbers that appear in the facts",
                Code
            ),
            (
                "no-time",
                "never estimates time",
                r"never estimate time",
                Code
            ),
        ]
    ),
    entry!(
        "router.retry",
        Oneshot,
        OneShots,
        Audience::None,
        "Order router, second try",
        "once per order, after an unusable first answer",
        "prompt!=the router prompt; error=what was wrong",
        &[]
    ),
    entry!(
        "retro",
        Oneshot,
        OneShots,
        Audience::None,
        "Retro",
        "each retro run (at most 2 a day)",
        "windowDays!=the window; metrics!=the metric classes; incidents!=the incidents; playbooks!=the playbook files",
        &[
            ("no-tools", "uses no tools", r"do not use tools", Code),
            ("at-most-3", "at most 3 changes", r"at most 3 changes", Code),
        ]
    ),
    Entry {
        id: "playbook.bugfix",
        title: "Playbook: bugfix",
        kind: K::Playbook,
        group: G::Playbooks,
        audience: Audience::None,
        sent_when: "in the digest and the intake wake, while an order follows it",
        default: BUNDLED[0].1,
        placeholders: "",
        rules: &[(
            "train-only-merges",
            "never merges; the train does",
            r"never merge",
            Code,
        )],
    },
    Entry {
        id: "playbook.feature",
        title: "Playbook: feature",
        kind: K::Playbook,
        group: G::Playbooks,
        audience: Audience::None,
        sent_when: "in the digest and the intake wake, while an order follows it",
        default: BUNDLED[1].1,
        placeholders: "",
        rules: &[(
            "train-only-merges",
            "never merges; the train does",
            r"never merge",
            Code,
        )],
    },
    Entry {
        id: "playbook.research",
        title: "Playbook: research",
        kind: K::Playbook,
        group: G::Playbooks,
        audience: Audience::None,
        sent_when: "in the digest and the intake wake, while an order follows it",
        default: BUNDLED[2].1,
        placeholders: "",
        rules: &[(
            "stop-is-success",
            "STOP is a success",
            r"STOP is success|STOP is a success",
            Prompt,
        )],
    },
    Entry {
        id: "playbook.finish-all",
        title: "Playbook: finish-all",
        kind: K::Playbook,
        group: G::Playbooks,
        audience: Audience::None,
        sent_when: "in the digest and the intake wake, while an order follows it",
        default: BUNDLED[3].1,
        placeholders: "",
        rules: &[],
    },
    Entry {
        id: INSTRUCTIONS,
        title: "Custom instructions",
        kind: K::Instructions,
        group: G::Instructions,
        audience: Audience::None,
        sent_when: "appended to every lead and task first message, global then project",
        default: asset!("instructions"),
        placeholders: "",
        rules: &[],
    },
];

pub const INSTRUCTIONS: &str = "instructions";

pub fn get(id: &str) -> Option<&'static Entry> {
    ENTRIES.iter().find(|e| e.id == id)
}

/// The entry, for ids the code names; a typo fails every test that renders it.
pub fn entry(id: &str) -> &'static Entry {
    get(id).unwrap_or_else(|| panic!("no prompt {id} in the registry"))
}
